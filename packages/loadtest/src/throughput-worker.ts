// Hosts a share of the clients in a worker thread, so fan-out parsing at 50
// clients does not make the harness itself the bottleneck.
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { parentPort, workerData } from 'node:worker_threads';
import WebSocket from 'ws';

interface Config {
  url: string;
  roomId: number;
  tokens: string[];
  clientOffset: number;
  mode: 'closed' | 'open';
  ratePerClient: number;
  runId: string;
}

interface ClientState {
  index: number;
  ws: WebSocket;
  seqs: number[];
  shapeIds: string[];
  /** shapeId -> [intended send time, sent during the measured window] */
  pending: Map<string, [number, boolean]>;
  nextSeqNumber: number;
  nextDue: number;
  sent: number;
  acked: number;
  errors: number;
  closes: number;
}

const config = workerData as Config;
const port = parentPort!;
const clients: ClientState[] = [];
const latencies: number[] = [];
const ackBuckets = new Map<number, number>();

let startAt = 0;
let measureFrom = 0;
let endAt = 0;
let acceptSends = false;
let lastReceiptAt = 0;

function sendOp(client: ClientState, intendedAt: number) {
  const shapeId = `${config.runId}-c${client.index}-${client.nextSeqNumber++}`;
  client.pending.set(shapeId, [intendedAt, intendedAt >= measureFrom]);
  client.sent += 1;
  client.ws.send(JSON.stringify({
    type: 'op',
    roomId: config.roomId,
    opType: 'CREATE',
    shapeId,
    payload: { id: shapeId, type: 'rect', x: 10, y: 20, width: 100, height: 50 },
  }));
}

function onFrame(client: ClientState, raw: WebSocket.RawData) {
  const frame = JSON.parse(raw.toString());
  const now = performance.now();
  lastReceiptAt = now;

  if (frame.type === 'op_ack') {
    client.seqs.push(frame.seq);
    client.shapeIds.push(frame.shapeId);
    const entry = client.pending.get(frame.shapeId);
    if (entry) {
      client.pending.delete(frame.shapeId);
      client.acked += 1;
      if (entry[1] && now <= endAt + 60_000) {
        latencies.push(now - entry[0]);
        const bucket = Math.floor((now - measureFrom) / 1000);
        ackBuckets.set(bucket, (ackBuckets.get(bucket) ?? 0) + 1);
      }
    }
    if (config.mode === 'closed' && acceptSends && now < endAt) sendOp(client, now);
  } else if (frame.type === 'op') {
    client.seqs.push(frame.seq);
    client.shapeIds.push(frame.shapeId);
  } else if (frame.type === 'error') {
    client.errors += 1;
    if (config.mode === 'closed') {
      // Error frames carry no op id. With one op in flight the match is exact.
      client.pending.clear();
      if (acceptSends && now < endAt) sendOp(client, now);
    }
  }
}

function connect(index: number, token: string): Promise<ClientState> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${config.url}?token=${token}`);
    const client: ClientState = {
      index, ws, seqs: [], shapeIds: [], pending: new Map(), nextSeqNumber: 0,
      nextDue: 0, sent: 0, acked: 0, errors: 0, closes: 0,
    };
    ws.on('message', (raw) => onFrame(client, raw));
    ws.on('close', () => { client.closes += 1; });
    ws.once('error', reject);
    ws.once('open', () => {
      ws.on('error', () => {});
      ws.send(JSON.stringify({ type: 'join_room', roomId: config.roomId }));
      resolve(client);
    });
  });
}

function summarizeClient(client: ClientState) {
  let inversions = 0;
  let firstInversion: [number, number] | null = null;
  let previous = -Infinity;
  for (const seq of client.seqs) {
    if (seq <= previous) {
      inversions += 1;
      firstInversion ??= [previous, seq];
    }
    if (seq > previous) previous = seq;
  }

  const arrival = createHash('sha256');
  for (const seq of client.seqs) arrival.update(`${seq},`);

  const order = client.seqs.map((_, position) => position)
    .sort((a, b) => client.seqs[a]! - client.seqs[b]!);
  const content = createHash('sha256');
  let duplicates = 0;
  let gaps = 0;
  let last: number | null = null;
  for (const position of order) {
    const seq = client.seqs[position]!;
    content.update(`${seq}:${client.shapeIds[position]}\n`);
    if (last !== null) {
      if (seq === last) duplicates += 1;
      else gaps += seq - last - 1;
    }
    last = seq;
  }

  return {
    index: client.index,
    received: client.seqs.length,
    minSeq: client.seqs.length ? client.seqs[order[0]!]! : null,
    maxSeq: last,
    inversions,
    firstInversion,
    duplicates,
    gaps,
    arrivalHash: arrival.digest('hex').slice(0, 16),
    contentHash: content.digest('hex').slice(0, 16),
    sent: client.sent,
    acked: client.acked,
    errors: client.errors,
    unacked: client.pending.size,
    closes: client.closes,
  };
}

async function settle(settleMs: number) {
  const deadline = performance.now() + settleMs;
  while (performance.now() < deadline) {
    const outstanding = clients.reduce((sum, client) => sum + client.pending.size, 0);
    if (outstanding === 0 && performance.now() - lastReceiptAt > 2000) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function run(warmupMs: number, durationMs: number, settleMs: number) {
  startAt = performance.now();
  measureFrom = startAt + warmupMs;
  endAt = measureFrom + durationMs;
  acceptSends = true;
  const eluStart = performance.eventLoopUtilization();

  let pacer: ReturnType<typeof setInterval> | undefined;
  if (config.mode === 'closed') {
    for (const client of clients) sendOp(client, performance.now());
  } else {
    const interval = 1000 / config.ratePerClient;
    clients.forEach((client, position) => {
      client.nextDue = startAt + (interval * position) / clients.length;
    });
    pacer = setInterval(() => {
      const now = performance.now();
      if (now >= endAt) return;
      for (const client of clients) {
        // The intended time stays the latency origin, which avoids coordinated omission.
        while (client.nextDue <= now && client.ws.readyState === WebSocket.OPEN) {
          sendOp(client, client.nextDue);
          client.nextDue += interval;
        }
      }
    }, 2);
  }

  await new Promise((resolve) => setTimeout(resolve, warmupMs + durationMs));
  acceptSends = false;
  if (pacer) clearInterval(pacer);
  const elu = performance.eventLoopUtilization(eluStart).utilization;

  await settle(settleMs);
  const summaries = clients.map(summarizeClient);
  for (const client of clients) client.ws.terminate();

  port.postMessage({
    type: 'result',
    latencies,
    ackBuckets: [...ackBuckets.entries()],
    clients: summaries,
    elu,
  });
}

port.on('message', (message) => {
  if (message.type === 'start') {
    run(message.warmupMs, message.durationMs, message.settleMs).catch((error) => {
      port.postMessage({ type: 'fatal', error: String(error) });
    });
  }
});

Promise.all(config.tokens.map((token, offset) => connect(config.clientOffset + offset, token)))
  .then((connected) => {
    clients.push(...connected);
    port.postMessage({ type: 'ready' });
  })
  .catch((error) => port.postMessage({ type: 'fatal', error: String(error) }));
