import { test } from 'node:test';
import { auditRoom, CaseRecord, rectOp, startStack, TestClient } from '../src/lib.ts';
import { uid } from './helpers.ts';

test('error frames name the op that failed', async () => {
  const record = new CaseRecord('error-frames');
  const stack = await startStack('error-frames');
  try {
    const member = await TestClient.connect(stack.ws.url, stack.token);
    member.join(stack.roomId);
    await member.waitFor(() => member.ofType('room_joined').length === 1, 3000);

    const shapeId = uid('blocked');
    await stack.pool.query(`ALTER TABLE "Operation" ADD CONSTRAINT lt_block CHECK (false) NOT VALID`);
    try {
      member.send(rectOp(stack.roomId, shapeId, 'UPDATE'));
      await member.waitFor(() => member.ofType('error').length === 1, 3000);
    } finally {
      await stack.pool.query(`ALTER TABLE "Operation" DROP CONSTRAINT lt_block`);
    }
    const failed = member.ofType('error')[0];
    record.check('failed insert names room, shape and type',
      failed?.roomId === stack.roomId && failed?.shapeId === shapeId && failed?.opType === 'UPDATE', failed);

    const after = uid('after');
    member.send(rectOp(stack.roomId, after));
    await member.waitFor(() => member.ofType('op_ack').length === 1, 3000);
    const audit = await auditRoom(stack.pool, stack.roomId);
    record.check('the failed op used no seq', member.ofType('op_ack')[0]?.seq === 1 && audit.contiguousFromOne, audit.rows);

    const outsider = await TestClient.connect(stack.ws.url, stack.token);
    const outsideShape = uid('outside');
    outsider.send(rectOp(stack.roomId, outsideShape));
    await outsider.waitFor(() => outsider.ofType('error').length === 1, 3000);
    const refused = outsider.ofType('error')[0];
    record.check('op from a non-member names room, shape and type',
      refused?.roomId === stack.roomId && refused?.shapeId === outsideShape && refused?.opType === 'CREATE', refused);

    const stray = await TestClient.connect(stack.ws.url, stack.token);
    stray.join(2_000_000_000);
    await stray.waitFor(() => stray.ofType('error').length === 1, 3000);
    const joinError = stray.ofType('error')[0];
    record.check('failed join names the room and no shape',
      joinError?.roomId === 2_000_000_000 && joinError?.shapeId === undefined, joinError);

    for (const client of [member, outsider, stray]) client.close();
  } finally {
    await stack.pool.query(`ALTER TABLE "Operation" DROP CONSTRAINT IF EXISTS lt_block`).catch(() => {});
    await stack.shutdown();
  }
  record.finish();
});
