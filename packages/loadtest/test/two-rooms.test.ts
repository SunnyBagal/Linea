import { test } from 'node:test';
import { auditRoom, CaseRecord, rectOp, seedRoom, sleep, startStack, TestClient } from '../src/lib.ts';
import { pace, uid } from './helpers.ts';

test('two rooms running concurrently do not cross-talk', async () => {
  const record = new CaseRecord('two-rooms');
  const stack = await startStack('two-rooms');
  try {
    const roomA = stack.roomId;
    const roomB = await seedRoom(stack.pool, stack.userId);
    const connect = async (...rooms: number[]) => {
      const client = await TestClient.connect(stack.ws.url, stack.token);
      for (const room of rooms) client.join(room);
      return client;
    };
    const writerA = await connect(roomA);
    const writerB = await connect(roomB);
    const observerA = await connect(roomA);
    const observerB = await connect(roomB);
    const both = await connect(roomA, roomB);
    await sleep(200);

    const pacers = [
      pace(() => writerA, roomA, 2, 'A'),
      pace(() => writerB, roomB, 2, 'B'),
    ];
    await sleep(15_000);
    pacers.forEach((pacer) => pacer.stop());
    await sleep(1000);

    const auditA = await auditRoom(stack.pool, roomA);
    const auditB = await auditRoom(stack.pool, roomB);
    const foreign = (client: TestClient, room: number) =>
      client.frames.filter((f) => f.roomId !== undefined && f.roomId !== room).length;
    const seqsIn = (client: TestClient, room: number) =>
      client.frames.filter((f) => f.type === 'op' && f.roomId === room).map((f) => f.seq);
    const increasing = (seqs: number[]) => seqs.every((seq, i) => i === 0 || seq > seqs[i - 1]!);

    record.fact('rowsA', auditA.rows);
    record.fact('rowsB', auditB.rows);
    record.fact('inversionsA', seqsIn(observerA, roomA).filter((s, i, a) => i > 0 && s <= a[i - 1]!).length);
    record.fact('inversionsB', seqsIn(observerB, roomB).filter((s, i, a) => i > 0 && s <= a[i - 1]!).length);

    record.check('room A clients see no room B frames', foreign(writerA, roomA) + foreign(observerA, roomA) === 0);
    record.check('room B clients see no room A frames', foreign(writerB, roomB) + foreign(observerB, roomB) === 0);
    record.check('database rows stay in their own room',
      [...auditA.bySeq.values()].every((id) => id.startsWith('A-'))
      && [...auditB.bySeq.values()].every((id) => id.startsWith('B-')));
    record.check('seq contiguous in both rooms', auditA.contiguousFromOne && auditB.contiguousFromOne);
    record.check('observer A saw every room A op', seqsIn(observerA, roomA).length === auditA.rows);
    record.check('observer B saw every room B op', seqsIn(observerB, roomB).length === auditB.rows);
    record.check('a client in both rooms saw both streams',
      seqsIn(both, roomA).length === auditA.rows && seqsIn(both, roomB).length === auditB.rows);
    record.check('observers saw ops in seq order', increasing(seqsIn(observerA, roomA)) && increasing(seqsIn(observerB, roomB)));
    for (const client of [writerA, writerB, observerA, observerB, both]) client.close();
  } finally {
    await stack.shutdown();
  }
  record.finish();
});

test('op sent to a room the client never joined is rejected', async () => {
  const record = new CaseRecord('op-without-join');
  const stack = await startStack('op-without-join');
  try {
    const member = await TestClient.connect(stack.ws.url, stack.token);
    const outsider = await TestClient.connect(stack.ws.url, stack.token);
    member.join(stack.roomId);
    await sleep(100);

    const opId = uid('outsider');
    outsider.send(rectOp(stack.roomId, opId));
    outsider.send({ type: 'chat', roomId: stack.roomId, message: 'from outside' });
    await sleep(500);

    const audit = await auditRoom(stack.pool, stack.roomId);
    const persisted = [...audit.bySeq.values()].includes(opId);
    record.fact('persisted', persisted);
    record.fact('memberReceived', member.frames.map((f) => f.type));
    record.fact('outsiderReplies', outsider.frames.map((f) => f.type));
    record.check('op from a non-member is not persisted', !persisted);
    record.check('frames from a non-member are not broadcast',
      member.ofType('op').length === 0 && member.ofType('chat').length === 0,
      { received: member.frames.map((f) => f.type) });
    record.check('rejected op gets the existing error frame', outsider.ofType('error').length === 1,
      { replies: outsider.frames.map((f) => f.type) });

    // Sending right after join_room must still work while the room lookup is in flight.
    const eager = await TestClient.connect(stack.ws.url, stack.token);
    const eagerOps = [uid('eager'), uid('eager'), uid('eager')];
    eager.join(stack.roomId);
    for (const shapeId of eagerOps) eager.send(rectOp(stack.roomId, shapeId));
    const allAcked = await eager.waitFor(() => eagerOps.every((id) => Boolean(eager.ackFor(id))), 3000);
    record.check('ops sent straight after join_room are accepted, in order', allAcked
      && eager.ofType('op_ack').every((ack, i) => ack.shapeId === eagerOps[i]),
      { acks: eager.ofType('op_ack').map((ack) => ack.shapeId) });

    // A pending join that fails must reject the op queued behind it.
    const failedJoin = await TestClient.connect(stack.ws.url, stack.token);
    failedJoin.join(999_999_999);
    failedJoin.send(rectOp(999_999_999, uid('failed')));
    await failedJoin.waitFor(() => failedJoin.ofType('error').length >= 2, 3000);
    record.check('op behind a failed join is rejected', failedJoin.ofType('error').length === 2
      && failedJoin.ofType('op_ack').length === 0, { replies: failedJoin.frames.map((f) => f.type) });

    // leave_room while the join is pending must leave the client out of the room.
    const leaver = await TestClient.connect(stack.ws.url, stack.token);
    leaver.join(stack.roomId);
    leaver.send({ type: 'leave_room', roomId: stack.roomId });
    await sleep(300);
    const framesBefore = leaver.frames.length;
    const probe = uid('probe');
    eager.send(rectOp(stack.roomId, probe));
    await eager.waitFor(() => Boolean(eager.ackFor(probe)), 3000);
    await sleep(200);
    record.check('leave_room during a pending join wins', leaver.frames.length === framesBefore,
      { received: leaver.frames.slice(framesBefore).map((f) => f.type) });

    for (const client of [eager, failedJoin, leaver]) client.close();
    member.close();
    outsider.close();
  } finally {
    await stack.shutdown();
  }
  record.finish();
});
