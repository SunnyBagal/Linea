import type { CanvasOp } from "./types.js";

// Log rules with no canvas or network code, so the load test harness can run them too.

export type LogEntry = CanvasOp;

export function highestSeq(ops: CanvasOp[]): number {
  let highest = 0;
  for (const op of ops) {
    if (op.seq !== undefined && op.seq > highest) highest = op.seq;
  }
  return highest;
}

/**
 * Builds the log after a catch-up: every confirmed op once, in seq order, then the
 * local ops still waiting for a reply. Fetched rows win over frames with the same seq.
 */
export function mergeCatchUp(fetched: CanvasOp[], buffered: CanvasOp[], log: LogEntry[]): LogEntry[] {
  const bySeq = new Map<number, LogEntry>();
  const unconfirmed: LogEntry[] = [];
  for (const entry of log) {
    if (entry.seq === undefined) unconfirmed.push(entry);
    else bySeq.set(entry.seq, entry);
  }
  for (const op of [...buffered, ...fetched]) {
    if (op.seq !== undefined) bySeq.set(op.seq, op);
  }
  const confirmed = [...bySeq.values()].sort((a, b) => a.seq! - b.seq!);
  return [...confirmed, ...unconfirmed];
}

/**
 * Gives the oldest unconfirmed op for this shape its seq. A catch-up can fetch the
 * op before its ack arrives; then the fetched row is kept and the local copy dropped.
 */
export function applyAck(log: LogEntry[], shapeId: string, seq: number): LogEntry[] {
  const index = log.findIndex((o) => o.shapeId === shapeId && o.seq === undefined);
  if (index < 0) return log;
  if (log.some((o) => o.seq === seq)) return log.filter((_, i) => i !== index);
  log[index]!.seq = seq;
  return log;
}
