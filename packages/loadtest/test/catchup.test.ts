import { test } from 'node:test';
import {
  auditRoom, CaseRecord, rectOp, seedRoom, sleep, startDbProxy, startStack, TestClient,
} from '../src/lib.ts';
import { BrowserSession, FetchBeforeJoinSession, pace, startHttp, uid } from './helpers.ts';

const CYCLES = 6;

/**
 * Runs both catch-up flows in turn under the same conditions while a writer keeps writing.
 * joinLagMs delays the join frame, so the join lands after the fetch, as on a slow socket.
 * slowFetch delays the HTTP backend's database replies, so the fetch ends after the join.
 */
async function compareFlows(name: string, { joinLagMs = 0, slowFetch = false }) {
  const record = new CaseRecord(name);
  const proxy = await startDbProxy(() => 150);
  const stack = await startStack(name);
  const http = await startHttp(name, slowFetch ? { databaseUrl: proxy.url } : {});
  try {
    const writer = await TestClient.connect(stack.ws.url, stack.token);
    writer.join(stack.roomId);
    await sleep(600);
    const writerPacer = pace(() => writer, stack.roomId, 10, 'writer');
    await sleep(300);

    const oldFlow: FetchBeforeJoinSession[] = [];
    const newFlow: BrowserSession[] = [];
    const clients: TestClient[] = [];
    for (let cycle = 0; cycle < CYCLES; cycle += 1) {
      for (const Flow of [FetchBeforeJoinSession, BrowserSession]) {
        const client = await TestClient.connect(stack.ws.url, stack.token);
        clients.push(client);
        const session = new Flow(client, stack.roomId, stack.token, joinLagMs);
        if (session instanceof BrowserSession) newFlow.push(session);
        else oldFlow.push(session);
        await session.start();
        await sleep(400);
      }
    }
    writerPacer.stop();
    await sleep(1500);
    [...oldFlow, ...newFlow].forEach((session) => session.stop());

    const audit = await auditRoom(stack.pool, stack.roomId);
    const total = (sessions: Array<{ diff: BrowserSession['diff'] }>, key: 'missing' | 'duplicates') =>
      sessions.reduce((sum, session) => sum + session.diff(audit)[key], 0);
    const old = { missing: total(oldFlow, 'missing'), duplicates: total(oldFlow, 'duplicates') };
    const fixed = { missing: total(newFlow, 'missing'), duplicates: total(newFlow, 'duplicates') };
    const fullLogs = newFlow.filter((session) => {
      const seqs = session.seqs;
      return seqs.every((seq, i) => seq === i + 1) && seqs.length === audit.rows;
    }).length;

    record.fact('sessionsPerFlow', CYCLES);
    record.fact('dbRows', audit.rows);
    record.fact('oldFlow', old);
    record.fact('newFlow', fixed);
    record.check('catch-up leaves no missing ops', fixed.missing === 0, fixed);
    record.check('catch-up leaves no duplicate ops', fixed.duplicates === 0, fixed);
    record.check('every session ends with seqs 1..N exactly', fullLogs === newFlow.length, { fullLogs, sessions: newFlow.length });
    for (const client of [...clients, writer]) client.close();
  } finally {
    await http.stop();
    await stack.shutdown();
    proxy.close();
  }
  record.finish();
}

test('catch-up: a late join does not lose ops', () => compareFlows('catchup-late-join', { joinLagMs: 100 }));
test('catch-up: a slow fetch does not duplicate ops', () => compareFlows('catchup-slow-fetch', { slowFetch: true }));

test('room_joined: carries the current seq, and only successful joins get one', async () => {
  const record = new CaseRecord('room-joined-reply');
  const stack = await startStack('room-joined-reply');
  try {
    const writer = await TestClient.connect(stack.ws.url, stack.token);
    writer.join(stack.roomId);
    const joined = await writer.waitFor(() => writer.ofType('room_joined').length === 1, 3000);
    record.check('empty room replies with seq 0', joined && writer.ofType('room_joined')[0].seq === 0, writer.frames);
    record.check('reply names the room', writer.ofType('room_joined')[0]?.roomId === stack.roomId);

    for (let i = 0; i < 5; i += 1) writer.send(rectOp(stack.roomId, uid('seed')));
    await writer.waitFor(() => writer.ofType('op_ack').length === 5, 3000);

    const late = await TestClient.connect(stack.ws.url, stack.token);
    late.join(stack.roomId);
    await late.waitFor(() => late.ofType('room_joined').length === 1, 3000);
    record.check('later join replies with the current seq', late.ofType('room_joined')[0]?.seq === 5, late.frames);

    const emptyRoom = await seedRoom(stack.pool, stack.userId);
    await stack.pool.query(`DELETE FROM "Room" WHERE id = $1`, [emptyRoom]);
    const stray = await TestClient.connect(stack.ws.url, stack.token);
    stray.join(emptyRoom);
    await stray.waitFor(() => stray.ofType('error').length === 1, 3000);
    record.check('unknown room gets an error and no reply',
      stray.ofType('error').length === 1 && stray.ofType('room_joined').length === 0, stray.frames);

    const leaver = await TestClient.connect(stack.ws.url, stack.token);
    leaver.join(stack.roomId);
    leaver.send({ type: 'leave_room', roomId: stack.roomId });
    await sleep(300);
    record.check('a leave during the join gets no reply', leaver.ofType('room_joined').length === 0, leaver.frames);

    const joiner = await TestClient.connect(stack.ws.url, stack.token);
    joiner.join(stack.roomId);
    writer.send(rectOp(stack.roomId, uid('after-join')));
    await joiner.waitFor(() => joiner.ofType('room_joined').length === 1, 3000);
    await writer.waitFor(() => writer.ofType('op_ack').length === 6, 3000);
    await sleep(200);
    const audit = await auditRoom(stack.pool, stack.roomId);
    const reply = joiner.ofType('room_joined')[0]?.seq as number;
    const broadcast = joiner.ofType('op').map((f) => f.seq as number);
    const above = [...audit.bySeq.keys()].filter((seq) => seq > reply);
    record.check('every op above the reply seq is broadcast to the joiner',
      above.every((seq) => broadcast.includes(seq)), { reply, broadcast, above });

    for (const client of [writer, late, stray, leaver, joiner]) client.close();
  } finally {
    await stack.shutdown();
  }
  record.finish();
});
