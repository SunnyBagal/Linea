# WebSocket throughput benchmark

Measures sustained op throughput through the real ws-backend path: WS frame →
server → **atomic seq assignment + Postgres write** (one `$transaction`:
`Room.currentSeq` increment then `Operation` insert) → `op_ack` to the sender +
broadcast to observers. This is the write path a live drawing session drives.

## The protocol it targets (read from `apps/ws-backend/src/index.ts`)

- **Auth:** JWT as a `?token=` **query param** at connect; verified with
  `JWT_SECRET`, `{ userId }` payload. (No header, no first-message handshake.)
- **`op` frame (client→server):** `{ type:"op", roomId, opType, shapeId, payload }`,
  `payload` a `ShapeSchema`-valid Shape (or `null` for DELETE).
- **seq:** assigned atomically inside a transaction; the room-row update
  serializes concurrent ops, so every op is one locked write round-trip.
- **ack:** the sender receives `{ type:"op_ack", roomId, shapeId, seq }` — so
  the bench uses **ack rate** as its throughput number (the honest one: it
  includes the DB write + seq transaction).
- **broadcast:** `{ type:"op", …, seq, userId }` to every other room member that
  has sent `join_room`.

## What's reported

- **(a) ACKED ops/sec** — rate of `op_ack` frames the sender receives over the
  window. Method is printed in the output (`op_ack frames`). An ack frame exists,
  so we use it rather than an observer-receive proxy.
- **(b) Fan-out latency** — sender-emit → observer-receive, p50/p95/p99, sampled
  on **CREATE** ops only (their shapeIds are unique; UPDATE/DELETE reuse ids, so
  they can't be unambiguously time-correlated).
- Backpressure (sender `ws.bufferedAmount` high-water mark) and error/`error`
  frames are logged every run; `--ramp` reports them per step.

## Run steps

One-time (installs `ws`/`@types/ws` into the bench workspace):

```bash
pnpm install
```

**Point everything at local Postgres.** Put the local URL in `.env.bench` at the
repo root (gitignored). The bench scripts pick it up automatically (loaded as the
last `--env-file`, overriding `packages/db/.env`), so no `--allow-remote` is
needed and the guard sees `localhost`:

```bash
echo 'DATABASE_URL=postgresql://admin:PASSWORD@localhost:5432/excalidraw_dev' > .env.bench
```

**The WS server must hit the same local DB**, or ops still write to Neon. Start
it with an inline override — this does **not** touch your main `.env`, and the
override lives only for that one process (close it and normal `pnpm dev` is back
on Neon):

```bash
DATABASE_URL='postgresql://admin:PASSWORD@localhost:5432/excalidraw_dev' \
  pnpm --filter ws-backend dev          # ws://localhost:8080, local DB

# then, in another terminal:
pnpm --filter bench ws                  # 30s window, 4 clients, 100 ops/sec
pnpm --filter bench ws --clients=6 --rate=200 --duration=30
pnpm --filter bench ws --ramp           # stepped 50→3200/s, find the knee
```

Both the bench banner and the guard will print `DB host: localhost`. If you ever
run against a non-local `DATABASE_URL`, the guard aborts unless you pass
`--allow-remote` (see below).

### tsx version pin (important)

Run **only** via `pnpm --filter bench <script>`. Those scripts use the bench
package's **local** `tsx@4.22.4` (in `devDependencies`). A bare global `tsx`
(e.g. 4.21) mishandles the CJS-interop on `@repo/db`'s named exports
(`import { prisma } from "@repo/db/client"` fails with "does not provide an
export named 'prisma'"). If you must invoke tsx directly, use
`./node_modules/.bin/tsx` from `bench/`, not a global one.

## The localhost safety guard

The bench **writes real `Operation` rows**. Before any connection, it parses
`DATABASE_URL` and aborts loudly unless the host is `localhost` / `127.0.0.1` /
`::1`, or `--allow-remote` is explicitly passed. The DB host is printed in the
startup banner every run. (`seed-ops.ts` shares the same guard.)

The bench-ws room's `Operation` rows are wiped and `Room.currentSeq` reset to 0
**at the start of every run** (not just the end), so a crashed run leaves nothing
behind.

## Honest sentence template

> "Sustained **\_\_ acked ops/sec** through the WS path (atomic seq assignment +
> Postgres write + broadcast), N clients, localhost WS server on \[hardware]."

If `--ramp` found a knee:

> "Acked throughput stopped keeping up with send rate at **\_\_ ops/sec**;
> sustained capacity ≈ **\_\_ acked ops/sec**."

## Do NOT claim

- **Localhost WS has no network RTT or TLS.** Real clients over the internet add
  round-trip + handshake latency; production numbers will be **lower** than these.
- **N=4 clients is not a load test or a concurrency claim.** It's one sender plus
  a few observers to exercise fan-out — not hundreds of concurrent editors.
- **Single server process, single machine, single room.** No horizontal scaling,
  no multi-room contention modeled.
- **Watch where the DB lives.** The guard prints the `DATABASE_URL` host. If it's
  a **remote** Postgres (e.g. Neon in another region), each op pays that DB's
  network RTT on its serialized write, and throughput will be far lower than
  against a local Postgres. Quote the number **with** the DB host, not without.

## If the knee is low — say so

The likely bottleneck is the **per-op Postgres write + seq transaction**: every
op takes a row lock on `Room` (to increment `currentSeq`) and inserts one
`Operation`, so ops for a room are serialized into one-write-at-a-time round
trips to the database. Against a remote DB this is dominated by DB RTT; even
locally it's a real per-op cost.

Naming that bottleneck with a measured number is worth more than a big headline
figure. If you need higher write throughput, that transaction is the thing to
attack (e.g. batch/pipeline seq assignment, or a server-side in-memory seq
counter flushed asynchronously) — and this bench is how you'd prove any such
change moved the knee.
