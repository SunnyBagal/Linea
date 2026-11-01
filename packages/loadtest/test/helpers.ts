import { randomBytes } from 'node:crypto';
import { startBackend, sleep, TestClient, rectOp, type Backend, type DbAudit } from '../src/lib.ts';
import { highestSeq, mergeCatchUp, type LogEntry } from '../../../apps/web/lib/canvas/oplog.ts';

export const HTTP_PORT = 18081;
export const uid = (prefix = 'op') => `${prefix}-${randomBytes(5).toString('hex')}`;

export const startHttp = (name: string, options: { databaseUrl?: string; env?: Record<string, string> } = {}): Promise<Backend> =>
  startBackend('http', HTTP_PORT, name, options);

/** Paces rect ops from one client until stopped, tracking what was sent. */
export function pace(client: () => TestClient, roomId: number, intervalMs: number, prefix: string) {
  const sent: string[] = [];
  const timer = setInterval(() => {
    const current = client();
    if (!current.isOpen) return;
    const shapeId = uid(prefix);
    sent.push(shapeId);
    current.send(rectOp(roomId, shapeId));
  }, intervalMs);
  return { sent, stop: () => clearInterval(timer) };
}

async function fetchSeqs(roomId: number, token: string): Promise<LogEntry[]> {
  const res = await fetch(`http://127.0.0.1:${HTTP_PORT}/operations/${roomId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await res.json() as { operations: Array<{ seq: number; shapeId: string; type: LogEntry['opType'] }> };
  return body.operations.map((op) => ({ opType: op.type, shapeId: op.shapeId, payload: null, seq: op.seq }));
}

function countDiff(seqs: number[], audit: DbAudit) {
  const counts = new Map<number, number>();
  for (const seq of seqs) counts.set(seq, (counts.get(seq) ?? 0) + 1);
  const maxSeen = seqs.length ? Math.max(...seqs) : 0;
  let missing = 0;
  for (const seq of audit.bySeq.keys()) if (seq <= maxSeen && !counts.has(seq)) missing += 1;
  let duplicates = 0;
  for (const count of counts.values()) if (count > 1) duplicates += count - 1;
  return { entries: seqs.length, maxSeen, missing, duplicates };
}

/**
 * Mirrors apps/web/app/components/canvas/CanvasBoard.tsx and runs its merge code:
 * send join_room, buffer live frames, fetch once room_joined arrives, then merge.
 * `seqs` is what the real client's op log would contain.
 */
export class BrowserSession {
  log: LogEntry[] = [];
  hydrated = false;
  joinedSeq: number | null = null;
  private lastSeq = 0;
  private buffer: LogEntry[] = [];
  private seenFrames = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    readonly client: TestClient,
    readonly roomId: number,
    private readonly token: string,
    private readonly joinLagMs = 0,
  ) {}

  get seqs() {
    return this.log.map((op) => op.seq!);
  }

  private drainFrames() {
    while (this.seenFrames < this.client.frames.length) {
      const frame = this.client.frames[this.seenFrames++];
      if (frame.type === 'room_joined') this.joinedSeq = frame.seq;
      if (frame.type !== 'op' && frame.type !== 'op_ack') continue;
      const op: LogEntry = { opType: frame.opType ?? 'CREATE', shapeId: frame.shapeId, payload: null, seq: frame.seq };
      if (!this.hydrated) {
        this.buffer.push(op);
      } else if (frame.seq > this.lastSeq) {
        this.lastSeq = frame.seq;
        this.log.push(op);
      }
    }
  }

  async start(): Promise<void> {
    this.seenFrames = this.client.frames.length;
    this.timer = setInterval(() => this.drainFrames(), 1);
    if (this.joinLagMs) await sleep(this.joinLagMs);
    this.client.join(this.roomId);
    const replied = await this.client.waitFor(() => this.client.ofType('room_joined').length > 0, 10_000);
    if (!replied) throw new Error('no room_joined reply');
    this.drainFrames();
    let fetched = await fetchSeqs(this.roomId, this.token);
    while (highestSeq(fetched) < this.joinedSeq!) fetched = await fetchSeqs(this.roomId, this.token);
    this.drainFrames();
    this.log = mergeCatchUp(fetched, this.buffer, this.log);
    this.lastSeq = highestSeq(this.log);
    this.buffer = [];
    this.hydrated = true;
  }

  stop() {
    this.drainFrames();
    if (this.timer) clearInterval(this.timer);
  }

  /** Compares this session's log with the database up to the last seq it saw. */
  diff(audit: DbAudit) {
    return countDiff(this.seqs, audit);
  }
}

/**
 * The web client before F11 was fixed: fetch and join at the same time, then append
 * the buffered frames with no dedupe. Kept to measure the fix against.
 */
export class FetchBeforeJoinSession {
  seqs: number[] = [];
  private hydrated = false;
  private buffer: number[] = [];
  private seenFrames = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    readonly client: TestClient,
    readonly roomId: number,
    private readonly token: string,
    private readonly joinLagMs = 0,
  ) {}

  private drainFrames() {
    while (this.seenFrames < this.client.frames.length) {
      const frame = this.client.frames[this.seenFrames++];
      if (frame.type !== 'op' && frame.type !== 'op_ack') continue;
      if (frame.type === 'op' && !this.hydrated) this.buffer.push(frame.seq);
      else this.seqs.push(frame.seq);
    }
  }

  async start(): Promise<void> {
    this.seenFrames = this.client.frames.length;
    this.timer = setInterval(() => this.drainFrames(), 1);
    const fetching = fetchSeqs(this.roomId, this.token);
    if (this.joinLagMs) await sleep(this.joinLagMs);
    this.client.join(this.roomId);
    const fetched = await fetching;
    // Wait for the join to land, as the buffered frames would in the browser.
    if (this.joinLagMs) await sleep(50);
    this.drainFrames();
    this.seqs = [...fetched.map((op) => op.seq!), ...this.buffer, ...this.seqs];
    this.buffer = [];
    this.hydrated = true;
  }

  stop() {
    this.drainFrames();
    if (this.timer) clearInterval(this.timer);
  }

  diff(audit: DbAudit) {
    return countDiff(this.seqs, audit);
  }
}

export async function settle(ms = 500) {
  await sleep(ms);
}
