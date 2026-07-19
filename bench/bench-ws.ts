// bench-ws.ts — sustained WebSocket op-throughput benchmark for the ws-backend.
//
// Spawns N synthetic clients that join one dedicated bench-ws room; one sender
// emits realistic ops at a target rate while the rest observe. Measures the
// honest end-to-end path: WS frame -> server -> atomic seq assignment + Postgres
// write -> op_ack back to sender + broadcast to observers.
//
// Reported:
//   (a) ACKED ops/sec  — rate of op_ack frames the sender receives (an ack frame
//       DOES exist in this protocol). Includes the DB write + seq transaction.
//   (b) Fan-out latency — sender-emit -> observer-receive, p50/p95/p99, sampled
//       on CREATE ops (unique shapeIds; UPDATE/DELETE reuse ids so aren't timed).
//
// Run:  pnpm --filter bench ws                       (30s window, defaults)
//       pnpm --filter bench ws --clients=6 --rate=200
//       pnpm --filter bench ws --ramp                (stepped, find the knee)
//       ...plus --allow-remote for a non-local DATABASE_URL.
//
// Requires the ws-backend running locally (pnpm --filter ws-backend dev).

import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import jwt from "jsonwebtoken";
import { prisma } from "@repo/db/client";
import {
  BENCH_USER_EMAIL,
  BENCH_USER_USERNAME,
  WS_URL,
  WS_ROOM_SLUG,
  assertLocalDb,
} from "./bench-config";
import { OpGenerator, assertValidPayload } from "./op-gen";

// --- args -------------------------------------------------------------------
function argNum(name: string, def: number): number {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return def;
  const n = Number(hit.split("=")[1]);
  return Number.isFinite(n) && n > 0 ? n : def;
}
const N_CLIENTS = Math.max(2, Math.floor(argNum("clients", 4)));
const TARGET_RATE = argNum("rate", 100);
const DURATION_S = argNum("duration", 30);
const RAMP = process.argv.includes("--ramp");

// --- shared measurement state ----------------------------------------------
let sendCount = 0;
let ackCount = 0;
let errorCount = 0;
let broadcastCount = 0;
let maxBuffered = 0;
const emitTimes = new Map<string, number>(); // CREATE shapeId -> emit ts
let latencies: number[] = [];

const gen = new OpGenerator();

// --- helpers ----------------------------------------------------------------
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)]!;
}
const fx = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : "n/a");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Ctx {
  roomId: number;
  token: string;
  sender: WebSocket;
  clients: WebSocket[];
}

async function setup(): Promise<Ctx> {
  // Ensure the bench user + dedicated room, then WIPE this room's ops and reset
  // currentSeq at the START (so re-runs are clean even after a crash).
  const user = await prisma.user.upsert({
    where: { email: BENCH_USER_EMAIL },
    update: {},
    create: { email: BENCH_USER_EMAIL, username: BENCH_USER_USERNAME, password: "bench-user-no-login", image: "" },
    select: { id: true },
  });
  const room = await prisma.room.upsert({
    where: { slug: WS_ROOM_SLUG },
    update: {},
    create: { slug: WS_ROOM_SLUG, adminId: user.id, currentSeq: 0 },
    select: { id: true },
  });
  await prisma.operation.deleteMany({ where: { roomId: room.id } });
  await prisma.snapshot.deleteMany({ where: { roomId: room.id } });
  await prisma.room.update({ where: { id: room.id }, data: { currentSeq: 0 } });

  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set (needed to auth the WS connection).");
  const token = jwt.sign({ userId: user.id }, secret, { expiresIn: "1h" });

  // Connect N clients (token delivered as ?token= query param, as the server expects).
  const clients: WebSocket[] = [];
  await Promise.all(
    Array.from({ length: N_CLIENTS }, (_, i) => {
      const ws = new WebSocket(`${WS_URL}?token=${token}`);
      clients.push(ws);
      ws.on("error", (err) => {
        errorCount++;
        console.error(`  client ${i} ws error:`, (err as Error).message);
      });
      return new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("close", () => reject(new Error(`client ${i} closed before open (auth rejected?)`)));
      });
    }),
  );

  const sender = clients[0]!;
  const primaryObserver = clients[1]!;

  // Sender: count acks and error frames.
  sender.on("message", (raw) => {
    let f: { type?: string };
    try {
      f = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (f.type === "op_ack") ackCount++;
    else if (f.type === "error") errorCount++;
  });

  // Primary observer: latency on CREATE broadcasts (unique shapeIds).
  primaryObserver.on("message", (raw) => {
    let f: { type?: string; opType?: string; shapeId?: string };
    try {
      f = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (f.type !== "op") return;
    broadcastCount++;
    if (f.opType === "CREATE" && f.shapeId && emitTimes.has(f.shapeId)) {
      latencies.push(performance.now() - emitTimes.get(f.shapeId)!);
      emitTimes.delete(f.shapeId);
    }
  });

  // Other observers just receive (exercises real fan-out cost on the server).
  for (let i = 2; i < clients.length; i++) {
    clients[i]!.on("message", () => {});
  }

  // All clients join the room. There's no join-ack, so settle briefly.
  const joinFrame = JSON.stringify({ type: "join_room", roomId: room.id });
  for (const ws of clients) ws.send(joinFrame);
  await sleep(500);

  return { roomId: room.id, token, sender, clients };
}

function emitOne(ctx: Ctx) {
  const op = gen.next();
  if (op.opType === "CREATE") emitTimes.set(op.shapeId, performance.now());
  ctx.sender.send(
    JSON.stringify({ type: "op", roomId: ctx.roomId, opType: op.opType, shapeId: op.shapeId, payload: op.payload }),
  );
  sendCount++;
  if (ctx.sender.bufferedAmount > maxBuffered) maxBuffered = ctx.sender.bufferedAmount;
}

// Pace emits at `rate` ops/sec for `durationMs`, self-correcting against drift.
async function paceWindow(ctx: Ctx, rate: number, durationMs: number) {
  const start = performance.now();
  const base = sendCount;
  return new Promise<void>((resolve) => {
    function tick() {
      const elapsed = performance.now() - start;
      if (elapsed >= durationMs) return resolve();
      const due = Math.floor((elapsed / 1000) * rate);
      while (sendCount - base < due) emitOne(ctx);
      setTimeout(tick, 2);
    }
    tick();
  });
}

async function runSingle(ctx: Ctx) {
  console.log(`\n=== SUSTAINED WINDOW — ${DURATION_S}s at target ${TARGET_RATE} ops/sec, ${N_CLIENTS} clients ===\n`);
  // Validate the generator's payloads once (not in the hot path).
  for (let i = 0; i < 20; i++) assertValidPayload(gen.next());

  const s0 = sendCount;
  const a0 = ackCount;
  maxBuffered = 0;
  emitTimes.clear();
  latencies = [];

  await paceWindow(ctx, TARGET_RATE, DURATION_S * 1000);
  await sleep(1000); // let in-flight acks/broadcasts settle

  const sent = sendCount - s0;
  const acked = ackCount - a0;
  const dur = DURATION_S;
  latencies.sort((a, b) => a - b);

  console.log(`  method: op_ack frames (sender-side ack rate)\n`);
  console.log(`  (a) ACKED throughput : ${fx(acked / dur)} ops/sec  (${acked} acked / ${dur}s)`);
  console.log(`      sender emit rate : ${fx(sent / dur)} ops/sec  (${sent} sent)`);
  console.log(
    `  (b) fan-out latency  : p50 ${fx(percentile(latencies, 50))}ms  p95 ${fx(percentile(latencies, 95))}ms  p99 ${fx(percentile(latencies, 99))}ms  (n=${latencies.length} CREATEs)`,
  );
  console.log(`      broadcasts seen  : ${broadcastCount} (primary observer)`);
  console.log(`      max ws bufferedAmount (sender): ${maxBuffered} bytes${maxBuffered > 0 ? "  <- backpressure" : ""}`);
  console.log(`      error frames     : ${errorCount}`);
  if (acked < sent * 0.9) {
    console.log(`\n  NOTE: acked (${fx(acked / dur)}/s) trails emit (${fx(sent / dur)}/s) — server is the limit at this rate.`);
  }
}

async function runRamp(ctx: Ctx) {
  console.log(`\n=== RAMP — stepwise send rate, ~10s/step, ${N_CLIENTS} clients ===\n`);
  for (let i = 0; i < 20; i++) assertValidPayload(gen.next());

  const steps = [50, 100, 200, 400, 800, 1600, 3200];
  const stepS = 10;
  let knee: { target: number; sustained: number } | null = null;
  let bestAcked = 0;

  console.log("  target/s |  sent/s | acked/s | keeps up | p95 lat | maxBuf | errs");
  console.log("  ---------+---------+---------+----------+---------+--------+-----");

  for (const target of steps) {
    const s0 = sendCount;
    const a0 = ackCount;
    const e0 = errorCount;
    maxBuffered = 0;
    emitTimes.clear();
    latencies = [];

    await paceWindow(ctx, target, stepS * 1000);
    await sleep(600);

    const sent = (sendCount - s0) / stepS;
    const acked = (ackCount - a0) / stepS;
    const errs = errorCount - e0;
    latencies.sort((a, b) => a - b);
    const keepsUp = acked >= target * 0.9;
    bestAcked = Math.max(bestAcked, acked);

    console.log(
      `  ${String(target).padStart(8)} | ${fx(sent).padStart(7)} | ${fx(acked).padStart(7)} | ${(keepsUp ? "yes" : "NO").padStart(8)} | ${fx(percentile(latencies, 95)).padStart(7)} | ${String(maxBuffered).padStart(6)} | ${errs}`,
    );

    if (!keepsUp && !knee) knee = { target, sustained: acked };
    // Stop once we're clearly past the knee (one confirming step done).
    if (knee && target >= knee.target * 2) break;
  }

  console.log("");
  if (knee) {
    console.log(`  KNEE: acked stopped keeping up at target ${knee.target} ops/sec.`);
    console.log(`  Sustained capacity ≈ ${fx(bestAcked)} acked ops/sec (best sustained before/at the knee).`);
  } else {
    console.log(`  No knee hit within tested steps; best sustained ≈ ${fx(bestAcked)} acked ops/sec.`);
  }
}

async function main() {
  const { host, allowRemote } = assertLocalDb(process.argv.slice(2));
  console.log(`WS throughput bench`);
  console.log(`  DB host   : ${host}${allowRemote ? " (--allow-remote)" : ""}`);
  console.log(`  WS server : ${WS_URL}`);
  console.log(`  clients   : ${N_CLIENTS} (1 sender + ${N_CLIENTS - 1} observers)`);
  console.log(`  mode      : ${RAMP ? "ramp" : `single ${DURATION_S}s window @ ${TARGET_RATE}/s`}`);

  let ctx: Ctx;
  try {
    ctx = await setup();
  } catch (err) {
    console.error(`\n  setup failed: ${(err as Error).message}`);
    console.error(`  Is the ws-backend running?  pnpm --filter ws-backend dev`);
    process.exitCode = 1;
    await prisma.$disconnect();
    return;
  }

  try {
    if (RAMP) await runRamp(ctx);
    else await runSingle(ctx);
  } finally {
    for (const ws of ctx.clients) ws.close();
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
