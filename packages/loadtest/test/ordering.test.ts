import { test } from 'node:test';
import {
  auditRoom, CaseRecord, rectOp, sleep, startDbProxy, startStack, TestClient,
} from '../src/lib.ts';
import { uid } from './helpers.ts';

test('ops reach every client in seq order when database replies overtake each other', async () => {
  const record = new CaseRecord('ordering-jitter');
  const proxy = await startDbProxy(() => Math.random() * 6);
  const stack = await startStack('ordering-jitter', { databaseUrl: proxy.url });
  try {
    const writers = await Promise.all(Array.from({ length: 8 }, () => TestClient.connect(stack.ws.url, stack.token)));
    const observer = await TestClient.connect(stack.ws.url, stack.token);
    for (const client of [...writers, observer]) client.join(stack.roomId);
    await sleep(500);

    // Closed loop: each writer sends its next op as soon as the last one is answered.
    const until = Date.now() + 10_000;
    await Promise.all(writers.map(async (writer) => {
      while (Date.now() < until) {
        const shapeId = uid();
        const answered = writer.frames.length;
        writer.send(rectOp(stack.roomId, shapeId));
        await writer.waitFor(() => Boolean(writer.ackFor(shapeId))
          || writer.frames.slice(answered).some((f) => f.type === 'error'), 5000);
      }
    }));
    await sleep(1000);

    const inversions = (seqs: number[]) => seqs.filter((seq, i) => i > 0 && seq <= seqs[i - 1]!).length;
    const seqsOf = (client: TestClient) =>
      client.frames.filter((f) => f.type === 'op' || f.type === 'op_ack').map((f) => f.seq as number);
    const perClient = [...writers, observer].map((client) => inversions(seqsOf(client)));
    const audit = await auditRoom(stack.pool, stack.roomId);

    record.fact('rows', audit.rows);
    record.fact('inversionsPerClient', perClient);
    record.check('load actually ran', audit.rows > 100, { rows: audit.rows });
    record.check('no client sees seq numbers out of order', perClient.every((count) => count === 0), { perClient });
    record.check('database seq contiguous', audit.contiguousFromOne && audit.currentSeqMatchesMax);
    for (const client of [...writers, observer]) client.close();
  } finally {
    await stack.shutdown();
    proxy.close();
  }
  record.finish();
});

test('an op backlog is answered within the wait limit and the room recovers', async () => {
  const record = new CaseRecord('ordering-backlog');
  // About 10 ms per database reply, so a room commits far fewer than 1000 ops/s.
  const proxy = await startDbProxy(() => 10);
  const stack = await startStack('ordering-backlog', { databaseUrl: proxy.url });
  try {
    const writer = await TestClient.connect(stack.ws.url, stack.token);
    writer.join(stack.roomId);
    await sleep(500);

    const total = 5000;
    for (let i = 0; i < total; i += 1) {
      writer.send(rectOp(stack.roomId, uid()));
      if (i % 10 === 9) await sleep(10);
    }
    const lastSentAt = performance.now();
    const answered = () => writer.ofType('op_ack').length + writer.ofType('error').length;
    const allAnswered = await writer.waitFor(() => answered() >= total, 30_000);
    const drainMs = performance.now() - lastSentAt;

    const after = uid('after');
    writer.send(rectOp(stack.roomId, after));
    const recoveredAt = performance.now();
    const recovered = await writer.waitFor(() => Boolean(writer.ackFor(after)), 3000);
    const recoverMs = performance.now() - recoveredAt;

    const audit = await auditRoom(stack.pool, stack.roomId);
    const peakRssMb = Math.max(...stack.ws.probe().map((s) => s.rss)) / 2 ** 20;

    record.fact('sent', total);
    record.fact('acked', writer.ofType('op_ack').length);
    record.fact('errors', writer.ofType('error').length);
    record.fact('drainMsAfterLastSend', drainMs);
    record.fact('recoverMs', recoverMs);
    record.fact('peakRssMb', peakRssMb);
    record.check('every op gets an ack or an error', allAnswered, { answered: answered(), total });
    record.check('the backlog drains shortly after the wait limit', drainMs < 4000, { drainMs });
    record.check('the room accepts ops again', recovered, { recoverMs });
    record.check('database seq contiguous', audit.contiguousFromOne && audit.currentSeqMatchesMax);
    writer.close();
  } finally {
    await stack.shutdown();
    proxy.close();
  }
  record.finish();
});
