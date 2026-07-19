# Op-log replay benchmark

Measures how fast Linea rebuilds board state from its Operation log — the
prefix-fold that runs on every room load. Two numbers are reported **separately
and must never be conflated**:

- **(A) Pure fold** — the ops are already in memory; we time *only* the fold.
  Reports **both** the old `ops.reduce(applyOp, [])` and the new `foldOps`
  (both from `apps/web/lib/canvas/canvas.ts`, imported, not copied) so you get a
  before/after in one run. This is the algorithmic cost.
- **(B) Hydration round-trip** — `GET /operations/:roomId` against the locally
  running HTTP backend, `JSON.parse`, then the fold (now `foldOps`, matching
  production). This is the real reload path, minus real network latency
  (it's localhost).

Before either measurement, a **correctness gate** asserts
`foldOps(ops)` deep-equals `ops.reduce(applyOp, [])` element-for-element for
every seeded room; the benchmark aborts if they ever diverge.

## What it exercises

- Reducer: `foldOps` on hydration, exactly as `CanvasBoard.tsx` now does on load
  (incoming live WS ops still use the single-op `applyOp` path, unchanged).
- Endpoint: `GET /operations/:roomId` on the HTTP server (port 3005), Bearer JWT.
- Data: realistic op mix (mostly CREATE, plus UPDATE drags and DELETEs,
  including compensating-op undo patterns) with Zod-valid payloads across all
  shape types (rect, circle, line, arrow, pencil, text), strictly increasing
  `seq`, and `Room.currentSeq` kept consistent.

## Run steps

One-time (registers `bench` as a workspace package and installs its deps):

```bash
pnpm install
```

Requires `packages/backend-common/.env` (`JWT_SECRET`) and a `DATABASE_URL`.
The bench scripts load, in order: `packages/backend-common/.env`,
`packages/db/.env`, then **`.env.bench` at the repo root if it exists** (last one
wins). Point the benches at **local Postgres** — not remote Neon — by putting the
local URL in `.env.bench`:

```bash
# repo root; gitignored. Overrides the Neon DATABASE_URL for benches only.
echo 'DATABASE_URL=postgresql://admin:PASSWORD@localhost:5432/excalidraw_dev' > .env.bench
```

With `.env.bench` present, benches run against local Postgres and the DB host in
their banner reads `localhost`. Without it, they fall back to whatever
`packages/db/.env` holds.

```bash
# 1. Seed the dedicated bench rooms (default scales: 1000 and 10000).
pnpm --filter bench seed
#    custom scales:
pnpm --filter bench seed 500 5000

# 2. For part (B), start the HTTP backend in another terminal, pointed at the
#    SAME local DB (inline override; does not touch your main .env):
DATABASE_URL='postgresql://admin:PASSWORD@localhost:5432/excalidraw_dev' \
  pnpm --filter http-backend dev

# 3. Run the benchmark.
pnpm --filter bench replay
```

Seeding is idempotent: re-running wipes and reseeds **only** the bench rooms
(slugs `bench-1000`, `bench-10000`, …) and a dedicated `bench@linea.local` user.
Real rooms and users are never touched. If the HTTP backend isn't running,
part (A) still reports and part (B) is skipped with a clear message.

## Reporting honestly

Fill these templates from the printed output:

> "Prefix-fold replay of 10k ops in **\_\_ ms** (pure in-process fold, p50)."

> "Full hydration of a 10k-op room — local HTTP fetch + JSON parse + fold — in
> **\_\_ ms** (p50), **\_\_ ms** (p95)."

Always name which number you're quoting and at which scale.

## Do NOT claim

- **The pure-fold number (A) is not page-load time.** It excludes the network
  request, the DB query, JSON serialization/parse, React render, and canvas
  paint. Never present (A) as "the board loads in \_\_ ms".
- **(B) has no real network RTT.** It runs against `localhost`, so it omits DNS,
  TLS, and internet latency between a real client and the deployed backend. A
  production reload will be slower than (B) by the real round-trip time.
- **These are single-machine, single-process numbers** tied to this hardware and
  the seeded data distribution — not a throughput or concurrency claim.
- **⚠️ Superseded numbers — do not quote.** Earlier part (B) hydration figures of
  **~82.9 ms @ 1k** and **~308–466 ms @ 10k** were measured against **remote Neon
  (ap-southeast-1)** and are dominated by cross-region DB RTT, not the local
  fetch/parse/fold. They are **superseded** by fresh runs against local Postgres
  (`.env.bench`). Re-run part (B) locally and quote only those. The pure-fold (A)
  numbers are CPU-only and unaffected by DB location.

## The O(n²) fold, and the O(n) fix

The original hydration fold was `ops.reduce(applyOp, [])`. `applyOp` is a *pure*
single-op reducer: CREATE does `[...shapes, next]`, UPDATE does `shapes.map(...)`,
DELETE does `shapes.filter(...)` — each op rebuilds the **entire** shapes array,
so folding `n` ops is **O(n²)**. The bench makes this unmistakable: throughput
*falls* as the room grows (≈519 ops/ms at 1k → ≈53 ops/ms at 10k), and wall time
scales ~88× for a 10× input.

The fix, `foldOps(ops)`, folds the same ops into a `Map<shapeId, Shape>`
(CREATE = set-if-absent, UPDATE = replace-in-place, DELETE = delete) and returns
`Array.from(map.values())` once — **O(n)**. Map iteration order preserves
insertion order, which mirrors `applyOp`'s append/replace/remove ordering, so the
output is identical (the correctness gate proves it element-for-element). It
folds in array order and never sorts, which is what keeps it exactly equal to
`reduce(applyOp)` and correct for optimistic live ops whose `seq` is still
`undefined`.

Measured on this machine (pure fold, p50):

| scale | OLD `reduce(applyOp)` O(n²) | NEW `foldOps` O(n) | speedup |
|------:|----------------------------:|-------------------:|--------:|
|  1k   | 1.93 ms                     | 0.07 ms            | ~29×    |
|  10k  | 187.85 ms                   | 0.59 ms            | ~316×   |

`foldOps` holds a roughly constant ~15–17k ops/ms at both scales — the flat
throughput that confirms linear behavior. The ~188 ms O(n²) fold at 10k also used
to be a large slice of the hydration round-trip (B), so replacing it visibly
shrinks (B) too — but quote (B) only from a **local** re-run (the earlier Neon
round-trip numbers are superseded; see "Do NOT claim").

## The honest takeaway (interview-ready)

`foldOps` makes replay **O(n)** — enough that the fold is no longer the
bottleneck at 10k (it's now sub-millisecond; hydration cost is dominated by the
DB read and JSON transfer). But it's still linear in *total* room history.

Production Linea has **no snapshots yet** (the `Snapshot` table exists but is
unused), so the whole op log is still replayed on every load. Snapshots remain
the eventual answer for very large rooms: periodically persist the folded state
(`stateAtSeq` already computes state at a given seq), then hydration becomes
"load latest snapshot + fold only the **tail** of ops" — **O(tail)** instead of
O(n). So the progression is honest and staged: O(n²) → **O(n) today (foldOps)**
→ O(tail) later (snapshots). Quote the measured numbers and frame it that way.
