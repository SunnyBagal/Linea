// bench-replay.ts — measure op-log replay, reported separately:
//
//   (A) PURE FOLD        in-process fold of ops already in memory. The
//                        algorithmic number. Excludes DB and network entirely.
//                        Reports BOTH the old O(n^2) reduce(applyOp) and the new
//                        O(n) foldOps so you get a before/after in one run.
//   (B) HYDRATION RT     GET /operations/:roomId against the local HTTP server
//                        + JSON parse + fold (now via the O(n) foldOps, matching
//                        production). Localhost, so NO real network RTT.
//
// Both use the SAME production reducers (`applyOp` / `foldOps` from apps/web),
// imported — not copied. See README-replay.md for how to read these honestly.
//
// Run:  pnpm --filter bench replay          (default scales: 1000, 10000)
// Requires: seeded bench rooms (pnpm --filter bench seed) and, for (B), the
// http-backend running locally (pnpm --filter http-backend dev).

import { performance } from "node:perf_hooks";
import jwt from "jsonwebtoken";
import { prisma } from "@repo/db/client";
import type { Shape } from "@repo/common/types";
// Production reducers + op type, imported by relative path (apps/web is a Next
// app, not a published package). roughjs et al. resolve from apps/web.
import { applyOp, foldOps } from "../apps/web/lib/canvas/canvas";
import type { CanvasOp } from "../apps/web/lib/canvas/types";
import { BENCH_USER_EMAIL, benchSlug, parseScales, HTTP_URL } from "./bench-config";

// Rows as returned by GET /operations/:roomId (and prisma.operation.findMany).
interface OpRow {
  seq: number;
  type: "CREATE" | "UPDATE" | "DELETE";
  shapeId: string;
  payload: Shape | null;
}

// Identical mapping to fetchOperations() in apps/web/lib/canvas/canvas.ts.
function toCanvasOp(row: OpRow): CanvasOp {
  return { opType: row.type, shapeId: row.shapeId, payload: row.payload ?? null, seq: row.seq };
}

// The OLD hydration fold — O(n^2): rebuilds the whole array per op. Baseline.
function reduceApplyOp(ops: CanvasOp[]): Shape[] {
  return ops.reduce<Shape[]>((shapes, op) => applyOp(shapes, op), []);
}

// --- stats helpers ----------------------------------------------------------
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return NaN;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)]!;
}
const ms = (n: number) => n.toFixed(2);

function timeFold(fold: (ops: CanvasOp[]) => Shape[], ops: CanvasOp[], iters: number, warmups: number) {
  for (let i = 0; i < warmups; i++) fold(ops);
  const samples: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    fold(ops);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return { p50: percentile(samples, 50), min: samples[0]!, max: samples[samples.length - 1]! };
}

interface RoomInfo {
  scale: number;
  roomId: number;
  ops: CanvasOp[];
}

async function loadRooms(scales: number[]): Promise<RoomInfo[]> {
  const rooms: RoomInfo[] = [];
  for (const scale of scales) {
    const room = await prisma.room.findUnique({
      where: { slug: benchSlug(scale) },
      select: { id: true },
    });
    if (!room) {
      console.warn(`  ! no bench room for scale ${scale} (slug ${benchSlug(scale)}); run seed first — skipping`);
      continue;
    }
    const rows = (await prisma.operation.findMany({
      where: { roomId: room.id },
      orderBy: { seq: "asc" },
      select: { seq: true, type: true, shapeId: true, payload: true },
    })) as unknown as OpRow[];
    rooms.push({ scale, roomId: room.id, ops: rows.map(toCanvasOp) });
  }
  return rooms;
}

// ===========================================================================
// Correctness gate: foldOps must equal reduce(applyOp) element-for-element.
// ===========================================================================
function deepEqualShapes(a: Shape[], b: Shape[]): { ok: boolean; detail: string } {
  if (a.length !== b.length) return { ok: false, detail: `length ${a.length} vs ${b.length}` };
  for (let i = 0; i < a.length; i++) {
    const sa = JSON.stringify(a[i]);
    const sb = JSON.stringify(b[i]);
    if (sa !== sb) return { ok: false, detail: `element ${i} differs:\n    foldOps:   ${sa}\n    reduce:    ${sb}` };
  }
  return { ok: true, detail: `${a.length} shapes match element-for-element` };
}

function runCorrectnessCheck(rooms: RoomInfo[]): boolean {
  console.log("\n=== CORRECTNESS — foldOps(ops) vs ops.reduce(applyOp, []) ===\n");
  let allOk = true;
  for (const { ops } of rooms) {
    const res = deepEqualShapes(foldOps(ops), reduceApplyOp(ops));
    allOk &&= res.ok;
    console.log(`  ${String(ops.length).padStart(6)} ops | ${res.ok ? "PASS" : "FAIL"} — ${res.detail}`);
  }
  return allOk;
}

// ===========================================================================
// (A) PURE FOLD — ops preloaded into memory; time ONLY the fold.
// ===========================================================================
function benchPureFold(rooms: RoomInfo[]) {
  console.log("\n=== (A) PURE FOLD — in-process, DB & network EXCLUDED ===");
  console.log("    (3 warmups, 10 timed iterations per scale)\n");

  for (const { ops } of rooms) {
    const n = ops.length;
    const oldR = timeFold(reduceApplyOp, ops, 10, 3);
    const newR = timeFold(foldOps, ops, 10, 3);
    const speedup = oldR.p50 / newR.p50;
    console.log(`  ${String(n).padStart(6)} ops`);
    console.log(
      `    OLD reduce(applyOp) O(n^2) | p50 ${ms(oldR.p50)}ms  min ${ms(oldR.min)}ms  max ${ms(oldR.max)}ms  | ${(n / oldR.p50).toFixed(1)} ops/ms`,
    );
    console.log(
      `    NEW foldOps         O(n)   | p50 ${ms(newR.p50)}ms  min ${ms(newR.min)}ms  max ${ms(newR.max)}ms  | ${(n / newR.p50).toFixed(1)} ops/ms`,
    );
    console.log(`    speedup: ${speedup.toFixed(1)}x\n`);
  }
}

// ===========================================================================
// (B) HYDRATION ROUND-TRIP — GET + parse + fold (foldOps) over local HTTP.
// ===========================================================================
async function benchHydration(rooms: RoomInfo[], token: string) {
  console.log("=== (B) HYDRATION ROUND-TRIP — local HTTP fetch + JSON parse + foldOps ===");
  console.log(`    (20 requests per scale against ${HTTP_URL}; localhost, so NO real network RTT)\n`);

  for (const { scale, roomId, ops } of rooms) {
    const url = `${HTTP_URL}/operations/${roomId}`;
    const samples: number[] = [];

    try {
      const probe = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!probe.ok) {
        console.warn(`  ! scale ${scale}: server returned ${probe.status} ${probe.statusText} — skipping`);
        continue;
      }
      await probe.json();
    } catch (err) {
      console.warn(
        `  ! scale ${scale}: could not reach ${HTTP_URL} — is http-backend running? — skipping (${(err as Error).message})`,
      );
      continue;
    }

    let failed = false;
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        failed = true;
        break;
      }
      const data = (await res.json()) as { operations?: OpRow[] };
      foldOps((data.operations ?? []).map(toCanvasOp));
      samples.push(performance.now() - t0);
    }
    if (failed || samples.length === 0) {
      console.warn(`  ! scale ${scale}: request failed mid-run — skipping`);
      continue;
    }

    samples.sort((a, b) => a - b);
    console.log(
      `  ${String(ops.length).padStart(6)} ops | ` +
        `p50 ${ms(percentile(samples, 50))}ms  p95 ${ms(percentile(samples, 95))}ms  (fetch + parse + fold, 20 reqs)`,
    );
  }
}

async function main() {
  const scales = parseScales(process.argv.slice(2));
  console.log(`Benchmarking replay for scales: ${scales.join(", ")}`);

  const rooms = await loadRooms(scales);
  if (rooms.length === 0) {
    console.error("No bench rooms found. Run:  pnpm --filter bench seed");
    process.exitCode = 1;
    return;
  }

  const ok = runCorrectnessCheck(rooms);
  if (!ok) {
    console.error("\nCorrectness check FAILED — foldOps diverges from applyOp. Aborting benchmark.");
    process.exitCode = 1;
    return;
  }

  benchPureFold(rooms);

  const secret = process.env.JWT_SECRET;
  const benchUser = await prisma.user.findUnique({
    where: { email: BENCH_USER_EMAIL },
    select: { id: true },
  });
  if (!secret) {
    console.warn("(B) skipped: JWT_SECRET not set (needed to auth the HTTP request).");
  } else if (!benchUser) {
    console.warn("(B) skipped: bench user missing — run seed first.");
  } else {
    const token = jwt.sign({ userId: benchUser.id }, secret, { expiresIn: "1h" });
    await benchHydration(rooms, token);
  }

  console.log(
    "\nReminder: (A) is the pure algorithmic fold — NOT page-load time. " +
      "(B) is localhost, so it excludes real network RTT. See README-replay.md.",
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
