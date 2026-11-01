import { test } from 'node:test';
import { auditRoom, CaseRecord, rectOp, sleep, startStack, TestClient } from '../src/lib.ts';
import { uid } from './helpers.ts';

const UNKNOWN = 999_999_999;
const OVER_INT4 = 2 ** 40;

const cases: Array<{ name: string; frame: (shapeId: string) => object; expectError: boolean }> = [
  { name: 'join-unknown', frame: () => ({ type: 'join_room', roomId: UNKNOWN }), expectError: true },
  { name: 'op-unknown', frame: (id) => rectOp(UNKNOWN, id), expectError: true },
  { name: 'chat-unknown', frame: () => ({ type: 'chat', roomId: UNKNOWN, message: 'hi' }), expectError: true },
  { name: 'leave-unknown', frame: () => ({ type: 'leave_room', roomId: UNKNOWN }), expectError: false },
  { name: 'join-over-int4', frame: () => ({ type: 'join_room', roomId: OVER_INT4 }), expectError: true },
  { name: 'op-over-int4', frame: (id) => rectOp(OVER_INT4, id), expectError: true },
  { name: 'chat-over-int4', frame: () => ({ type: 'chat', roomId: OVER_INT4, message: 'hi' }), expectError: true },
  { name: 'join-negative', frame: () => ({ type: 'join_room', roomId: -1 }), expectError: true },
];

for (const scenario of cases) {
  test(`unknown room: ${scenario.name}`, async () => {
    const record = new CaseRecord(`unknown-room-${scenario.name}`);
    const stack = await startStack(`unknown-${scenario.name}`);
    try {
      const client = await TestClient.connect(stack.ws.url, stack.token);
      const bystander = await TestClient.connect(stack.ws.url, stack.token);
      client.join(stack.roomId);
      bystander.join(stack.roomId);
      await sleep(100);

      client.send(scenario.frame(uid('x')));
      await sleep(500);

      const alive = await stack.ws.alive();
      record.fact('replies', client.frames.map((f) => f.type));
      record.fact('exit', stack.ws.exitInfo());
      record.fact('clientCloseCode', client.closeCode);
      record.fact('bystanderCloseCode', bystander.closeCode);
      record.check('server stays up', alive, { exit: stack.ws.exitInfo(), log: stack.ws.logTail() });

      if (alive) {
        const ping = uid('ping');
        bystander.send(rectOp(stack.roomId, ping));
        record.check('other clients are unaffected', await bystander.waitFor(() => Boolean(bystander.ackFor(ping)), 3000));
        const audit = await auditRoom(stack.pool, stack.roomId);
        record.check('real room seq is unaffected', audit.contiguousFromOne && audit.rows === 1, { rows: audit.rows });
      }
      if (scenario.expectError) {
        record.check('sender is told about the failure', client.ofType('error').length > 0,
          { replies: client.frames.map((f) => f.type) });
      }
      client.close();
      bystander.close();
    } finally {
      await stack.shutdown();
    }
    record.finish();
  });
}
