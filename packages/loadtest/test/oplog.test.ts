import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyAck, highestSeq, mergeCatchUp, rejectEntry, undoStackAfterReject, type LogEntry,
} from '../../../apps/web/lib/canvas/oplog.ts';

// A computed path, so the harness type check stays out of the web app's canvas code.
const canvasModule: string = '../../../apps/web/lib/canvas/canvas.ts';
const { foldOps } = await import(canvasModule) as { foldOps(ops: LogEntry[]): Array<{ id: string }> };

const op = (shapeId: string, seq?: number, opType: LogEntry['opType'] = 'CREATE'): LogEntry =>
  ({ opType, shapeId, payload: null, seq });

const rect = (id: string, x = 0) => ({ id, type: 'rect' as const, x, y: 0, width: 10, height: 10 });
const create = (id: string, seq?: number, x = 0): LogEntry =>
  ({ opType: 'CREATE', shapeId: id, payload: rect(id, x), seq });

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

test('rejectEntry + foldOps: a rejected CREATE removes the shape and keeps the others', () => {
  const log = [create('a', 1), create('b')];
  const { log: next, rejected } = rejectEntry(log, 'b', 'CREATE');
  assert.equal(rejected, log[1]);
  assert.deepEqual(foldOps(next).map((s) => s.id), ['a']);
});

test('rejectEntry + foldOps: a rejected UPDATE puts the shape back', () => {
  const log = [create('a', 1, 5), { ...create('a', undefined, 99), opType: 'UPDATE' as const }];
  const { log: next } = rejectEntry(log, 'a', 'UPDATE');
  assert.deepEqual(foldOps(next), [rect('a', 5)]);
});

test('rejectEntry + foldOps: a rejected DELETE brings the shape back', () => {
  const log: LogEntry[] = [create('a', 1), { opType: 'DELETE', shapeId: 'a', payload: null }];
  const { log: next } = rejectEntry(log, 'a', 'DELETE');
  assert.deepEqual(foldOps(next).map((s) => s.id), ['a']);
});

test('rejectEntry: keeps later unconfirmed work on the same shape', () => {
  const log = [create('a', 1, 1), { ...create('a', undefined, 2), opType: 'UPDATE' as const }, { ...create('a', undefined, 3), opType: 'UPDATE' as const }];
  const { log: next } = rejectEntry(log, 'a', 'UPDATE');
  assert.deepEqual(foldOps(next), [rect('a', 3)]);
});

test('rejectEntry: ignores confirmed ops and ops of another type', () => {
  const log = [create('a', 1)];
  assert.equal(rejectEntry(log, 'a', 'CREATE').rejected, null);
  assert.equal(rejectEntry(log, 'a', 'DELETE').rejected, null);
  assert.equal(rejectEntry(log, 'zzz', 'CREATE').log, log);
});

test('undoStackAfterReject: drops the step the rejected op added, by identity', () => {
  const inverse: LogEntry = { opType: 'DELETE', shapeId: 'a', payload: null };
  const lookalike: LogEntry = { ...inverse };
  const next = undoStackAfterReject([lookalike, inverse], { ...op('a'), undoEntry: inverse });
  assert.equal(next.length, 1);
  assert.equal(next[0], lookalike);
});

test('undoStackAfterReject: a rejected undo can be tried again', () => {
  const inverse: LogEntry = { opType: 'DELETE', shapeId: 'a', payload: null };
  assert.deepEqual(undoStackAfterReject([], { ...inverse, undoRestore: inverse }), [inverse]);
});
