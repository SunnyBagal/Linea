import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { auditRoom, CaseRecord, rectOp, sleep, startStack, TestClient } from '../src/lib.ts';
import { uid } from './helpers.ts';

test('malformed frames leave the server and the connection usable', async () => {
  const record = new CaseRecord('malformed-json');
  const stack = await startStack('malformed');
  try {
    const client = await TestClient.connect(stack.ws.url, stack.token);
    client.join(stack.roomId);
    await sleep(100);
    const room = stack.roomId;
    const valid = (patch: object) => JSON.stringify({ ...rectOp(room, uid('bad')), ...patch });

    const cases: Array<[string, string | Buffer]> = [
      ['not json', 'not json'],
      ['truncated json', '{"type":"op"'],
      ['empty frame', ''],
      ['json null', 'null'],
      ['json array', '[]'],
      ['json number', '42'],
      ['unknown type', '{"type":"nope"}'],
      ['op with no fields', '{"type":"op"}'],
      ['string roomId', valid({ roomId: String(room) })],
      ['float roomId', valid({ roomId: 1.5 })],
      ['bad opType', valid({ opType: 'EXPLODE' })],
      ['bad payload', valid({ payload: { id: 'x', type: 'hexagon' } })],
      ['proto key', `{"__proto__":{"polluted":true},"type":"join_room","roomId":${room}}`],
      ['binary frame', randomBytes(256)],
      ['deep nesting', `${'['.repeat(200_000)}${']'.repeat(200_000)}`],
      ['NUL in shapeId', valid({ shapeId: 'a\u0000b' })],
      ['NUL in text payload', valid({ payload: { id: 'x', type: 'text', x: 1, y: 2, fontSize: 1, text: 'a\u0000b' } })],
      ['shapeId over index limit', valid({ shapeId: randomBytes(8000).toString('hex') })],
    ];

    const outcomes: Array<Record<string, unknown>> = [];
    for (const [name, frame] of cases) {
      const before = client.frames.length;
      const logBefore = stack.ws.logBytes();
      client.send(frame);
      await sleep(30);
      const replies = client.frames.slice(before).map((f) => f.type);

      // The same connection must still sequence a valid op afterwards.
      const ping = uid('ping');
      let recovered = false;
      if (client.isOpen) {
        client.send(rectOp(room, ping));
        recovered = await client.waitFor(() => Boolean(client.ackFor(ping)), 3000);
      }
      outcomes.push({
        name,
        replies,
        recovered,
        open: client.isOpen,
        closeCode: client.closeCode,
        logBytesAdded: stack.ws.logBytes() - logBefore,
      });
      if (!recovered) break;
    }
    const audit = await auditRoom(stack.pool, room);

    record.fact('outcomes', outcomes);
    record.fact('dbRows', audit.rows);
    record.check('server stays up', await stack.ws.alive(), { exit: stack.ws.exitInfo(), log: stack.ws.logTail() });
    record.check('all frames were exercised', outcomes.length === cases.length, { reached: outcomes.length });
    record.check('connection recovers after every frame', outcomes.every((o) => o.recovered),
      outcomes.filter((o) => !o.recovered).map((o) => o.name));
    record.check('failed ops do not burn seq numbers', audit.contiguousFromOne && audit.currentSeqMatchesMax,
      { rows: audit.rows, currentSeq: audit.currentSeq, maxSeq: audit.maxSeq });
    record.check('invalid frames get an error reply', outcomes.every((o) => (o.replies as string[]).length > 0
      || ['proto key'].includes(o.name as string)),
      outcomes.filter((o) => (o.replies as string[]).length === 0).map((o) => o.name));
    client.close();
  } finally {
    await stack.shutdown();
  }
  record.finish();
});
