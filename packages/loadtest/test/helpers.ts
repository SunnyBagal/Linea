import { randomBytes } from 'node:crypto';
import { startBackend, sleep, TestClient, rectOp, type Backend, type DbAudit } from '../src/lib.ts';

export const HTTP_PORT = 18081;
export const uid = (prefix = 'op') => `${prefix}-${randomBytes(5).toString('hex')}`;

export const startHttp = (name: string): Promise<Backend> => startBackend('http', HTTP_PORT, name);

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

/**
 * Mirrors apps/web/app/components/canvas/CanvasBoard.tsx: start the HTTP fetch,
 * send join_room, buffer live ops while hydrating, then append the buffer to the
 * fetched log. Like the browser it does not dedupe by seq, so `seqs` is what the
 * real client's op log would contain.
 */
export class BrowserSession {
  seqs: number[] = [];
  hydrated = false;
  private buffer: number[] = [];
  private seenFrames = 0;
  private timer?: ReturnType<typeof setInterval>;

  constructor(readonly client: TestClient, readonly roomId: number, private readonly token: string) {}

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
    const fetching = fetch(`http://127.0.0.1:${HTTP_PORT}/operations/${this.roomId}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    this.client.join(this.roomId);
    const body = await (await fetching).json() as { operations: Array<{ seq: number }> };
    this.drainFrames();
    this.seqs = [...body.operations.map((op) => op.seq), ...this.buffer, ...this.seqs];
    this.buffer = [];
    this.hydrated = true;
  }

  stop() {
    this.drainFrames();
    if (this.timer) clearInterval(this.timer);
  }

  /** Compares this session's log with the database up to the last seq it saw. */
  diff(audit: DbAudit) {
    const counts = new Map<number, number>();
    for (const seq of this.seqs) counts.set(seq, (counts.get(seq) ?? 0) + 1);
    const maxSeen = this.seqs.length ? Math.max(...this.seqs) : 0;
    let missing = 0;
    for (const seq of audit.bySeq.keys()) if (seq <= maxSeen && !counts.has(seq)) missing += 1;
    let duplicates = 0;
    for (const count of counts.values()) if (count > 1) duplicates += count - 1;
    return { entries: this.seqs.length, maxSeen, missing, duplicates };
  }
}

export async function settle(ms = 500) {
  await sleep(ms);
}
