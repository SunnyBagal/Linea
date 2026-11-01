import { test } from 'node:test';
import { auditRoom, CaseRecord, rectOp, sleep, startStack, TestClient } from '../src/lib.ts';
import { uid } from './helpers.ts';

test('duplicate op resend is idempotent', async () => {
  const record = new CaseRecord('duplicate-resend');
  const stack = await startStack('duplicate');
  try {
    const sender = await TestClient.connect(stack.ws.url, stack.token);
    const observer = await TestClient.connect(stack.ws.url, stack.token);
    sender.join(stack.roomId);
    observer.join(stack.roomId);
    await sleep(100);

    // A retry after the first ack, as a client would resend after a lost ack.
    const retried = uid('retry');
    const frame = rectOp(stack.roomId, retried);
    sender.send(frame);
    await sender.waitFor(() => sender.ofType('op_ack').length === 1);
    sender.send(frame);
    await sender.waitFor(() => sender.ofType('op_ack').length === 2, 1000);

    // The same frame twice back to back, both in flight together.
    const doubled = uid('double');
    const doubledFrame = rectOp(stack.roomId, doubled);
    sender.send(doubledFrame);
    sender.send(doubledFrame);
    await sleep(500);

    const audit = await auditRoom(stack.pool, stack.roomId);
    const rowsFor = (id: string) => [...audit.bySeq.values()].filter((shapeId) => shapeId === id).length;
    record.fact('retriedRows', rowsFor(retried));
    record.fact('doubledRows', rowsFor(doubled));
    record.fact('observerFramesForRetried', observer.ofType('op').filter((f) => f.shapeId === retried).map((f) => f.seq));
    record.fact('senderAcksForRetried', sender.ofType('op_ack').filter((f) => f.shapeId === retried).map((f) => f.seq));

    record.check('retry after ack creates one row', rowsFor(retried) === 1, { rows: rowsFor(retried) });
    record.check('in-flight double send creates one row', rowsFor(doubled) === 1, { rows: rowsFor(doubled) });
    record.check('observer sees the retried op once',
      observer.ofType('op').filter((f) => f.shapeId === retried).length === 1);
    sender.close();
    observer.close();
  } finally {
    await stack.shutdown();
  }
  record.finish();
});
