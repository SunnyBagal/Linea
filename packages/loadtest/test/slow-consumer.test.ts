import { test } from 'node:test';
import {
  auditRoom, CaseRecord, percentile, sleep, startStack, textOp, TestClient,
} from '../src/lib.ts';
import { uid } from './helpers.ts';

const MIB = 2 ** 20;
const OP_BYTES = 32 * 1024;
const OPS_PER_SECOND = 100;
// Long enough to span two 30s heartbeat ticks, the only existing eviction path.
const RUN_MS = 75_000;
/** The most a single stalled socket may hold in server memory. */
const BUFFER_LIMIT_BYTES = 8 * MIB;
/** Well before the first possible heartbeat eviction at 60s. */
const EVICTION_DEADLINE_SEC = 20;

async function runLoad(name: string, slowConsumer: boolean) {
  const stack = await startStack(name);
  try {
    const writer = await TestClient.connect(stack.ws.url, stack.token);
    const healthy = await TestClient.connect(stack.ws.url, stack.token);
    const slow = slowConsumer ? await TestClient.connect(stack.ws.url, stack.token) : null;
    writer.join(stack.roomId);
    healthy.join(stack.roomId);
    slow?.join(stack.roomId);
    await sleep(200);
    // Stops reading: the kernel buffers fill, then the server's send queue grows.
    (slow?.ws as unknown as { _socket?: { pause(): void } } | undefined)?._socket?.pause();

    const sentAt = new Map<string, number>();
    const latencies: number[] = [];
    let seen = 0;
    const timer = setInterval(() => {
      const shapeId = uid('w');
      sentAt.set(shapeId, performance.now());
      writer.send(textOp(stack.roomId, shapeId, OP_BYTES));
      for (; seen < writer.frames.length; seen += 1) {
        const frame = writer.frames[seen];
        const start = frame.type === 'op_ack' ? sentAt.get(frame.shapeId) : undefined;
        if (start !== undefined) latencies.push(performance.now() - start);
      }
      // Frames are only inspected for latency, so keep the test client's memory flat.
      if (writer.frames.length > 10_000) {
        writer.frames.splice(0, seen);
        seen = 0;
      }
      if (healthy.frames.length > 10_000) healthy.frames.length = 0;
    }, 1000 / OPS_PER_SECOND);

    await sleep(RUN_MS);
    clearInterval(timer);
    await sleep(1000);

    const samples = stack.ws.probe();
    const sorted = latencies.slice().sort((a, b) => a - b);
    const audit = await auditRoom(stack.pool, stack.roomId);
    const peakBuffered = Math.max(...samples.map((s) => s.maxBuffered));
    const peakAt = samples.findIndex((s) => s.maxBuffered === peakBuffered);
    const evictedAtSample = samples.findIndex((s, i) => i > peakAt && s.maxBuffered < peakBuffered / 2);

    return {
      alive: await stack.ws.alive(),
      exit: stack.ws.exitInfo(),
      opsPersisted: audit.rows,
      writerAckP50Ms: percentile(sorted, 50),
      writerAckP99Ms: percentile(sorted, 99),
      peakBufferedMb: peakBuffered / MIB,
      peakBufferedAtSec: peakAt,
      bufferDroppedAtSec: evictedAtSample >= 0 ? evictedAtSample : null,
      rssStartMb: (samples[0]?.rss ?? 0) / MIB,
      rssPeakMb: Math.max(...samples.map((s) => s.rss)) / MIB,
      slowCloseCode: slow?.closeCode ?? null,
      healthyCloseCode: healthy.closeCode,
      writerCloseCode: writer.closeCode,
      bufferedSeries: samples.filter((_, i) => i % 5 === 0).map((s) => Math.round(s.maxBuffered / MIB)),
      rssSeries: samples.filter((_, i) => i % 5 === 0).map((s) => Math.round(s.rss / MIB)),
      peakBuffered,
    };
  } finally {
    await stack.shutdown();
  }
}

test('slow consumer does not grow server memory without bound', { timeout: 300_000 }, async () => {
  const record = new CaseRecord('slow-consumer');
  const control = await runLoad('slow-control', false);
  const slow = await runLoad('slow-paused', true);

  record.fact('load', { opBytes: OP_BYTES, opsPerSecond: OPS_PER_SECOND, runMs: RUN_MS });
  record.fact('control', control);
  record.fact('slowConsumer', slow);
  record.check('server stays up', slow.alive, slow.exit);
  record.check('buffer for one stalled socket stays under the limit', slow.peakBuffered <= BUFFER_LIMIT_BYTES,
    { peakBufferedMb: slow.peakBufferedMb, limitMb: BUFFER_LIMIT_BYTES / MIB });
  record.check('stalled socket is evicted before the heartbeat would do it',
    slow.bufferDroppedAtSec !== null && slow.bufferDroppedAtSec <= EVICTION_DEADLINE_SEC,
    { bufferDroppedAtSec: slow.bufferDroppedAtSec });
  record.check('healthy clients stay connected', slow.healthyCloseCode === null && slow.writerCloseCode === null,
    { healthy: slow.healthyCloseCode, writer: slow.writerCloseCode });
  record.check('healthy clients are not slowed by the stalled socket',
    (slow.writerAckP99Ms ?? 0) <= Math.max(2 * (control.writerAckP99Ms ?? 0), 50),
    { control: control.writerAckP99Ms, slow: slow.writerAckP99Ms });
  record.finish();
});
