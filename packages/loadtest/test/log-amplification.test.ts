import { test } from 'node:test';
import { CaseRecord, sleep, startStack, TestClient } from '../src/lib.ts';
import { uid } from './helpers.ts';

const LOG_LIMIT_BYTES = 16 * 1024;

test('schema-invalid frames add only a small log entry', async () => {
  const record = new CaseRecord('log-amplification');
  const stack = await startStack('log-amplification');
  try {
    const client = await TestClient.connect(stack.ws.url, stack.token);
    const room = stack.roomId;
    const frames = {
      // Under the frame limit, wrong type: tests that the raw frame is not logged.
      largeJunkField: { type: 'op', roomId: room, opType: 'NOPE', shapeId: uid(), junk: 'x'.repeat(900_000) },
      // One validation issue per bad point: tests that the issue list is capped too.
      manyInvalidPoints: {
        type: 'op',
        roomId: room,
        opType: 'CREATE',
        shapeId: uid(),
        payload: { id: 'p', type: 'pencil', points: Array.from({ length: 40_000 }, () => ({ x: 'a', y: 'b' })) },
      },
    };

    const added: Record<string, number> = {};
    for (const [name, frame] of Object.entries(frames)) {
      const before = stack.ws.logBytes();
      client.send(frame);
      await sleep(500);
      added[name] = stack.ws.logBytes() - before;
    }

    record.fact('logBytesAdded', added);
    record.check('server stays up', await stack.ws.alive());
    for (const [name, bytes] of Object.entries(added)) {
      record.check(`${name} stays under the log limit`, bytes < LOG_LIMIT_BYTES, { bytes });
    }
    client.close();
  } finally {
    await stack.shutdown();
  }
  record.finish();
});
