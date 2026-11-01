import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAck, highestSeq, mergeCatchUp, type LogEntry } from '../../../apps/web/lib/canvas/oplog.ts';

const op = (shapeId: string, seq?: number, opType: LogEntry['opType'] = 'CREATE'): LogEntry =>
  ({ opType, shapeId, payload: null, seq });

test('mergeCatchUp: each seq once, in order, with unconfirmed ops last', () => {
  const merged = mergeCatchUp(
    [op('a', 1), op('b', 2), op('c', 3)],
    [op('c', 3), op('d', 4)],
    [op('b', 2), op('mine'), op('e', 5)],
  );
  assert.deepEqual(merged.map((o) => [o.shapeId, o.seq]), [
    ['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 5], ['mine', undefined],
  ]);
});

test('mergeCatchUp: keeps the same object for unconfirmed ops, so a later ack finds it', () => {
  const mine = op('mine');
  assert.equal(mergeCatchUp([], [], [mine])[0], mine);
});

test('highestSeq: ignores unconfirmed ops', () => {
  assert.equal(highestSeq([op('a', 4), op('b')]), 4);
  assert.equal(highestSeq([]), 0);
});

test('applyAck: confirms the oldest unconfirmed op for that shape', () => {
  const log = [op('a'), op('a', undefined, 'UPDATE')];
  const next = applyAck(log, 'a', 7);
  assert.deepEqual(next.map((o) => o.seq), [7, undefined]);
});

test('applyAck: drops the local copy when the fetch already brought that seq', () => {
  const next = applyAck([op('a', 7), op('a')], 'a', 7);
  assert.deepEqual(next.map((o) => o.seq), [7]);
});

test('applyAck: an ack for no known op changes nothing', () => {
  const log = [op('a', 1)];
  assert.equal(applyAck(log, 'zzz', 2), log);
});
