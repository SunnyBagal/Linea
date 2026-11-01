import { test } from 'node:test';
import { auditRoom, CaseRecord, rectOp, sleep, startStack, textOp, TestClient } from '../src/lib.ts';
import { uid } from './helpers.ts';

const MIB = 2 ** 20;

const cases = [
  // Just under the 1 MiB limit once the JSON envelope is counted.
  { name: '1MiB valid op', bytes: MIB - 1024, valid: true, mustReject: false },
  { name: '2MiB valid op', bytes: 2 * MIB, valid: true, mustReject: true },
  { name: '8MiB valid op', bytes: 8 * MIB, valid: true, mustReject: true },
  { name: '64MiB valid op', bytes: 64 * MIB, valid: true, mustReject: true },
  { name: '64MiB schema-invalid frame', bytes: 64 * MIB, valid: false, mustReject: true },
  { name: '110MiB frame over the ws default', bytes: 110 * MIB, valid: true, mustReject: true },
];

for (const scenario of cases) {
  const slug = `oversized-${scenario.name.split(' ')[0]!.toLowerCase()}-${scenario.valid ? 'valid' : 'invalid'}`;

  test(`oversized payload: ${scenario.name}`, async () => {
    const record = new CaseRecord(slug);
    const stack = await startStack(slug);
    try {
      const attacker = await TestClient.connect(stack.ws.url, stack.token);
      const bystander = await TestClient.connect(stack.ws.url, stack.token);
      attacker.join(stack.roomId);
      bystander.join(stack.roomId);
      await sleep(1200);
      const rssBefore = stack.ws.probe().at(-1)?.rss ?? 0;
      const logBefore = stack.ws.logBytes();

      // The bystander's op latency shows how long the server's single thread stalls.
      const latencies: number[] = [];
      let measuring = true;
      const measure = (async () => {
        while (measuring && bystander.isOpen) {
          const id = uid('by');
          const start = performance.now();
          bystander.send(rectOp(stack.roomId, id));
          await bystander.waitFor(() => Boolean(bystander.ackFor(id)), 30_000);
          latencies.push(performance.now() - start);
          await sleep(10);
        }
      })();
      await sleep(300);

      const shapeId = uid('big');
      const frame = scenario.valid
        ? JSON.stringify(textOp(stack.roomId, shapeId, scenario.bytes))
        : JSON.stringify({ type: 'op', roomId: stack.roomId, opType: 'NOPE', shapeId, junk: 'x'.repeat(scenario.bytes) });
      attacker.ws.send(frame, () => {});
      await attacker.waitFor(() => Boolean(attacker.ackFor(shapeId)) || attacker.closeCode !== null
        || attacker.ofType('error').length > 0, scenario.valid ? 30_000 : 6_000);
      await sleep(1500);
      measuring = false;
      await measure;

      const samples = stack.ws.probe();
      const audit = await auditRoom(stack.pool, stack.roomId);
      const persisted = [...audit.bySeq.values()].includes(shapeId);
      const logAdded = stack.ws.logBytes() - logBefore;
      const worstStallMs = latencies.length ? Math.max(...latencies) : null;

      record.fact('frameBytes', frame.length);
      record.fact('acked', Boolean(attacker.ackFor(shapeId)));
      record.fact('persisted', persisted);
      record.fact('attackerCloseCode', attacker.closeCode);
      record.fact('errorFrames', attacker.ofType('error').length);
      record.fact('rssBeforeMb', rssBefore / MIB);
      record.fact('rssPeakMb', Math.max(...samples.map((s) => s.rss)) / MIB);
      record.fact('logBytesAdded', logAdded);
      record.fact('bystanderWorstAckMs', worstStallMs);
      record.fact('bystanderSamples', latencies.length);

      record.check('server stays up', await stack.ws.alive(), { exit: stack.ws.exitInfo(), log: stack.ws.logTail() });
      record.check('bystander connection survives', bystander.isOpen);
      if (scenario.mustReject) {
        record.check('oversized frame is not persisted', !persisted);
        record.check('oversized frame is rejected before parsing (close 1009)', attacker.closeCode === 1009,
          { closeCode: attacker.closeCode });
      } else {
        record.check('frame within the limit is persisted', persisted);
      }
      record.check('a rejected frame is not copied into the log', logAdded < MIB, { logAdded });
      attacker.close();
      bystander.close();
    } finally {
      await stack.shutdown();
    }
    record.finish();
  });
}
