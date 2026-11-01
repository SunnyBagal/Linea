# ws-backend load test

Every figure below comes from `packages/loadtest` and is stored in `packages/loadtest/results/`. The server under test is unchanged from `0f574e3`; the harness commit is `4225f36`.

## How to rerun

```sh
pnpm install
cd packages/loadtest
bash run-all.sh <label>           # about 50 minutes: chaos, then throughput twice
npx tsx src/report.ts <label> <label>-fullfsync
```

Everything runs locally: the real `ws-backend` and `http-backend` builds, plus a throwaway Postgres on `127.0.0.1:55433`. The harness refuses any non-local database URL, gives child processes a minimal explicit env, and applies migrations with `psql` instead of the Prisma CLI.

## Caveats

- **Hardware:** Apple M1 Pro, 10 cores, 16 GB, Node 24.14.1, Postgres 17.10 (Homebrew). This is a Mac, not a container. Server, Postgres and clients share the machine, and other apps may have been running.
- **Not production:** nothing here measures Neon or Railway. Localhost has almost no network latency, while each op holds the room's row lock across several database round trips. Production capacity could be much lower, and this harness does not measure it.
- **Disk flush dominates:** by default macOS Postgres (`wal_sync_method=open_datasync`) doesn't force the drive cache to flush. `fsync_writethrough` does. Both are reported because they differ by about 20x. Neither stands in for production storage.
- **Harness load:** the busiest client worker reached an event-loop utilization of 0.29, so the harness was not the bottleneck.
- **Variance:** the first repetition was noticeably worse than the other two in several cells, so look at all three rows and not only the medians.
- **Earlier numbers:** `bench/results` used Docker on macOS and counted an op complete when all observers received it. Here an op is complete when the sender gets `op_ack`. The two sets are not directly comparable.
- **Chaos thresholds are choices, not measurements:** the 1 MiB frame limit, the 32 MiB socket buffer limit, and the expectation that invalid frames get an error reply.

## Is ~800 acked ops/sec real?

It depends on the cost of a commit:

| Postgres sync | Clients | Closed-loop capacity (acked/s) | Offered 800/s: acked/s | Offered 800/s: p50 / p95 / p99 ms | Rejected |
|---|---|---|---|---|---|
| default (no cache flush) | 5 | 3591.4 | 800.0 | 2.3 / 4.0 / 4.8 | 0 |
| default (no cache flush) | 20 | 2383.6 | 800.0 | 2.3 / 4.2 / 5.1 | 0 |
| default (no cache flush) | 50 | 1780.8 | 800.0 | 2.5 / 4.2 / 5.3 | 0 |
| `fsync_writethrough` | 5 | 167.1 | 153.3 | 2048.4 / 2152.1 / 2236.0 | 76.7–80.9% |
| `fsync_writethrough` | 20 | 144.6 | 155.8 | 2047.7 / 2153.6 / 2226.4 | 75.7–80.2% |
| `fsync_writethrough` | 50 | 143.2 | 147.7 | 2050.5 / 2158.8 / 2248.3 | 79.3–81.5% |

Values are medians of 3 runs, 60 s each after a 5 s warm-up. Rejected is the range across the 3 runs.

The claim holds on this machine with default sync, including at 50 clients. In the first repetition p99 reached 176.4 ms at 5 clients and 97.8 ms at 50. It does not hold once each commit really flushes to disk: the room's row lock serialises commits, so a slow commit caps the whole room. No ops were lost silently in those runs, because every unacked op got an `error` frame. The failures are Prisma `P2028`, raised when a transaction can't start within its wait limit (41,519 of 41,519 logged failures in the one run inspected, `open:800`, 20 clients, rep 3).

Throughput correctness held in all 36 runs: no gaps, no duplicates, contiguous database seqs, `currentSeq` equal to the max seq, and client content matching the database. Arrival order was identical across clients in every run, but see F6.

## Findings

Severity is my judgment. Each row links to a chaos case or throughput table below.

| # | Severity | Finding | Evidence | Fix size |
|---|---|---|---|---|
| F1 | Critical | One `join_room` with a `roomId` beyond INT4 crashes the server and disconnects everyone. Any authenticated user can send it. | `unknown-room-join-over-int4`: exit code 1, Prisma `P2020`, bystander closed 1006 | Small |
| F2 | Critical | `join_room` during a database outage crashes the server. Same cause as F1: the lookup is outside any try/catch. | `db-outage`: exit code 1. `op` and `chat` during the outage are survived. | Small, shared with F1 |
| F3 | High | Frames up to the `ws` default of 100 MiB are accepted. A 64 MiB op was persisted and acked. | `oversized-64mib-valid`: RSS 118→707 MB, bystander ack up to 515 ms | Small, needs a limit |
| F4 | High | Schema-invalid frames are written to the log in full. | `oversized-64mib-invalid`: 67,109,312 log bytes from one frame, RSS peak 509 MB | Small |
| F5 | High | No backpressure for slow consumers. One stalled socket reached 175 MiB of buffer; only the 60 s heartbeat eviction ended it. | `slow-consumer`: at 3.2 MB/s, RSS peak 610 MB against 330 MB control. Healthy-client p99 barely moved (21.5 against 20.5 ms). | Small |
| F6 | High | Broadcasts and acks can leave out of seq order, because each message is an independent async task. | 5 of 18 default-sync runs, 1–3 inversions per client, e.g. 107028 after 107030. None under `fsync_writethrough`. All clients see the same wrong order. | Medium |
| F7 | High | Overload rejects most ops, and the web client ignores `error` frames. The local optimistic op stays on screen though it was never persisted. | `before-fullfsync` at 800/s: 76–82% rejected. `CanvasBoard.tsx` has no `error` branch. | Large: per-op transaction design, plus a web change |
| F8 | Medium | Resends are not idempotent. Each resend gets a new row and seq. | `duplicate-resend`: 2 rows for both retry and in-flight double send. The browser doesn't retry today, so this is latent. An op can still persist without an ack (3 of 2269 in `reconnect-mid-burst`). | Large: needs a client op id and a schema change |
| F9 | Medium | `op` and `chat` are accepted from a client that never joined the room. `join_room` itself has no authorization. | `op-without-join`: persisted, acked and broadcast | Small for membership; authorization is a product decision |
| F10 | Low | No SIGTERM handling, so deploys close clients with 1006 and drop in-flight work. | `restart-sigterm`: close codes 1006. No acked op was lost. | Small |
| F11 | Low | The web catch-up flow can add the same op to its log twice, because buffered ops aren't deduped by seq. `applyOp` tolerates this for shapes, but the op log used for time travel keeps the extra entry. | `reconnect-mid-burst`: 20 duplicate entries over 9 sessions, 0 missing | Small, in `apps/web` |
| F12 | Low | Failures are silent: no reply to malformed frames, unknown-room joins or failed chats. | `malformed-json`, `unknown-room-*` | Small |

## What held up

- **Room isolation:** no cross-talk in `two-rooms`, about 7,000 ops per room, and a client in both rooms saw both streams complete.
- **Crash durability:** in `restart-sigkill` and `restart-sigterm` every acked op survived with its seq, seqs continued after the restart, and reconnected clients matched the database.
- **Bad input:** 18 malformed frames caused no crash and the connection recovered after each. Failed ops did not burn seq numbers.
- **Unknown rooms:** `op` to an unknown or out-of-range room returns an `error` frame and the server stays up.
- **Over 100 MiB:** a 110 MiB frame is closed with 1009.
- **Abrupt disconnects:** no missing ops after catch-up in `reconnect-mid-burst`. The fetch-before-join gap that the code suggests did not reproduce here, which does not prove it can't happen.

## Raw results: Phase 1 baseline

### Throughput: `before`

Commit `4225f362bd6bf13e122da15f1095cfd94f802727`, Apple M1 Pro, 10 cores, 16 GB, darwin 27.0.0, Node v24.14.1. Postgres 17.10 (Homebrew): fsync=on, synchronous_commit=on, wal_sync_method=open_datasync. 60s measured after 5s warm-up, fresh server and room per run.

| mode | clients | rep | acked/s | worst 1s | p50 ms | p95 ms | p99 ms | max ms | errors | unacked | server CPU | PG CPU | harness ELU |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 5 | 1 | 2896.0 | 2118 | 1.5 | 3.4 | 5.2 | 30.4 | 0 | 0 | 0.76 | 0.75 | 0.13 |
| closed | 20 | 1 | 2033.4 | 1226 | 8.6 | 18.2 | 26.0 | 244.1 | 0 | 0 | 0.75 | 0.82 | 0.18 |
| closed | 50 | 1 | 1386.3 | 1149 | 34.4 | 50.2 | 62.3 | 172.9 | 0 | 0 | 0.78 | 0.64 | 0.28 |
| open:800 | 5 | 1 | 800.0 | 730 | 2.3 | 6.0 | 176.4 | 464.6 | 0 | 0 | 0.30 | 0.12 | 0.06 |
| open:800 | 20 | 1 | 800.0 | 798 | 2.5 | 4.5 | 20.8 | 137.1 | 0 | 0 | 0.36 | 0.15 | 0.09 |
| open:800 | 50 | 1 | 800.0 | 739 | 2.5 | 11.5 | 97.8 | 201.4 | 0 | 0 | 0.42 | 0.17 | 0.15 |
| closed | 5 | 2 | 3634.7 | 3102 | 1.3 | 2.3 | 3.5 | 27.1 | 0 | 0 | 0.82 | 0.66 | 0.15 |
| closed | 20 | 2 | 2418.1 | 2148 | 7.4 | 14.5 | 19.7 | 54.1 | 0 | 0 | 0.75 | 0.78 | 0.18 |
| closed | 50 | 2 | 1780.8 | 1480 | 26.7 | 37.9 | 46.5 | 263.0 | 0 | 0 | 0.81 | 0.60 | 0.29 |
| open:800 | 5 | 2 | 800.0 | 799 | 2.4 | 3.6 | 4.6 | 32.7 | 0 | 0 | 0.29 | 0.16 | 0.05 |
| open:800 | 20 | 2 | 800.0 | 800 | 2.2 | 4.0 | 4.8 | 30.7 | 0 | 0 | 0.30 | 0.08 | 0.09 |
| open:800 | 50 | 2 | 800.0 | 799 | 2.5 | 4.2 | 5.1 | 67.9 | 0 | 0 | 0.37 | 0.09 | 0.12 |
| closed | 5 | 3 | 3591.4 | 3131 | 1.3 | 2.4 | 3.5 | 28.4 | 0 | 0 | 0.82 | 0.66 | 0.15 |
| closed | 20 | 3 | 2383.6 | 2082 | 7.4 | 14.9 | 20.4 | 67.3 | 0 | 0 | 0.76 | 0.79 | 0.18 |
| closed | 50 | 3 | 1795.8 | 1600 | 26.5 | 36.9 | 44.7 | 267.6 | 0 | 0 | 0.83 | 0.65 | 0.29 |
| open:800 | 5 | 3 | 800.0 | 798 | 2.3 | 4.0 | 4.8 | 28.3 | 0 | 0 | 0.29 | 0.07 | 0.05 |
| open:800 | 20 | 3 | 800.0 | 799 | 2.3 | 4.2 | 5.1 | 22.8 | 0 | 0 | 0.29 | 0.07 | 0.09 |
| open:800 | 50 | 3 | 800.0 | 799 | 2.7 | 4.2 | 5.3 | 55.7 | 0 | 0 | 0.36 | 0.05 | 0.21 |

Median across reps:

| mode | clients | reps | acked/s | worst 1s | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| closed | 5 | 3 | 3591.4 | 3102 | 1.3 | 2.4 | 3.5 |
| closed | 20 | 3 | 2383.6 | 2082 | 7.4 | 14.9 | 20.4 |
| closed | 50 | 3 | 1780.8 | 1480 | 26.7 | 37.9 | 46.5 |
| open:800 | 5 | 3 | 800.0 | 798 | 2.3 | 4.0 | 4.8 |
| open:800 | 20 | 3 | 800.0 | 799 | 2.3 | 4.2 | 5.1 |
| open:800 | 50 | 3 | 800.0 | 799 | 2.5 | 4.2 | 5.3 |

Convergence (arrival order compares all clients; inversions are seqs arriving after a higher seq):

| mode | clients | rep | same arrival order | content = DB | clients with inversions | max inversions | gaps | dups | DB contiguous | currentSeq = max | DB rows | persist failures | crashed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 5 | 1 | true | true | 0/5 | 0 | 0 | 0 | true | true | 188551 | 0 | false |
| closed | 20 | 1 | true | true | 20/20 | 2 | 0 | 0 | true | true | 132091 | 0 | false |
| closed | 50 | 1 | true | true | 50/50 | 3 | 0 | 0 | true | true | 89800 | 0 | false |
| open:800 | 5 | 1 | true | true | 0/5 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| open:800 | 20 | 1 | true | true | 20/20 | 1 | 0 | 0 | true | true | 52000 | 0 | false |
| open:800 | 50 | 1 | true | true | 50/50 | 1 | 0 | 0 | true | true | 52000 | 0 | false |
| closed | 5 | 2 | true | true | 0/5 | 0 | 0 | 0 | true | true | 231756 | 0 | false |
| closed | 20 | 2 | true | true | 0/20 | 0 | 0 | 0 | true | true | 156278 | 0 | false |
| closed | 50 | 2 | true | true | 50/50 | 2 | 0 | 0 | true | true | 115149 | 0 | false |
| open:800 | 5 | 2 | true | true | 0/5 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| open:800 | 20 | 2 | true | true | 0/20 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| open:800 | 50 | 2 | true | true | 0/50 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| closed | 5 | 3 | true | true | 0/5 | 0 | 0 | 0 | true | true | 231411 | 0 | false |
| closed | 20 | 3 | true | true | 0/20 | 0 | 0 | 0 | true | true | 154021 | 0 | false |
| closed | 50 | 3 | true | true | 0/50 | 0 | 0 | 0 | true | true | 116162 | 0 | false |
| open:800 | 5 | 3 | true | true | 0/5 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| open:800 | 20 | 3 | true | true | 0/20 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| open:800 | 50 | 3 | true | true | 0/50 | 0 | 0 | 0 | true | true | 52000 | 0 | false |

### Chaos: `before`

Commit `4225f362bd6bf13e122da15f1095cfd94f802727`.

| case | result | failed checks |
|---|---|---|
| db-outage | FAIL | server survives join_room during the outage; ops flow again once the database returns |
| duplicate-resend | FAIL | retry after ack creates one row; in-flight double send creates one row; observer sees the retried op once |
| malformed-json | FAIL | invalid frames get an error reply |
| op-without-join | FAIL | op from a non-member is not persisted; frames from a non-member are not broadcast |
| oversized-110mib-valid | pass |  |
| oversized-1mib-valid | pass |  |
| oversized-64mib-invalid | FAIL | oversized frame is rejected before parsing (close 1009); a rejected frame is not copied into the log |
| oversized-64mib-valid | FAIL | oversized frame is not persisted; oversized frame is rejected before parsing (close 1009) |
| oversized-8mib-valid | FAIL | oversized frame is not persisted; oversized frame is rejected before parsing (close 1009) |
| reconnect-mid-burst | FAIL | catch-up leaves no duplicate ops |
| restart-sigkill | pass |  |
| restart-sigterm | FAIL | SIGTERM closes sockets with 1001 or 1012 |
| slow-consumer | FAIL | buffer for one stalled socket stays under the limit |
| two-rooms | pass |  |
| unknown-room-chat-over-int4 | FAIL | sender is told about the failure |
| unknown-room-chat-unknown | FAIL | sender is told about the failure |
| unknown-room-join-negative | FAIL | sender is told about the failure |
| unknown-room-join-over-int4 | FAIL | server stays up; sender is told about the failure |
| unknown-room-join-unknown | FAIL | sender is told about the failure |
| unknown-room-leave-unknown | pass |  |
| unknown-room-op-over-int4 | pass |  |
| unknown-room-op-unknown | pass |  |

Measured facts per case:

<details><summary>db-outage</summary>

```json
{
 "errorFrameForOp": true,
 "aliveAfterOpAndChat": true,
 "aliveAfterJoin": false,
 "exitDuringOutage": {
  "code": 1,
  "signal": null
 },
 "logTail": "  },\n  clientVersion: '7.8.0'\n}\n\nNode.js v24.14.1\n"
}
```

</details>

<details><summary>duplicate-resend</summary>

```json
{
 "retriedRows": 2,
 "doubledRows": 2,
 "observerFramesForRetried": [
  1,
  2
 ],
 "senderAcksForRetried": [
  1,
  2
 ]
}
```

</details>

<details><summary>malformed-json</summary>

```json
{
 "outcomes": [
  {
   "name": "not json",
   "replies": [],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 0
  },
  {
   "name": "truncated json",
   "replies": [],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 0
  },
  {
   "name": "empty frame",
   "replies": [],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 0
  },
  {
   "name": "json null",
   "replies": [],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 178
  },
  {
   "name": "json array",
   "replies": [],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 177
  },
  {
   "name": "json number",
   "replies": [],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 178
  },
  {
   "name": "unknown type",
   "replies": [],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 349
  },
  {
   "name": "op with no fields",
   "replies": [],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 682
  },
  {
   "name": "string roomId",
   "replies": [],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 344
  },
  {
   "name": "float roomId",
   "replies": [],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 360
  },
  {
   "name": "bad opType",
   "replies": [],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 377
  },
  {
   "name": "bad payload",
   "replies": [],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 479
  },
  {
   "name": "proto key",
   "replies": [],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 0
  },
  {
   "name": "binary frame",
   "replies": [],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 1280
  },
  {
   "name": "deep nesting",
   "replies": [],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 400175
  },
  {
   "name": "NUL in shapeId",
   "replies": [
    "error"
   ],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 1515
  },
  {
   "name": "NUL in text payload",
   "replies": [
    "error"
   ],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 1508
  },
  {
   "name": "shapeId over index limit",
   "replies": [
    "error"
   ],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 1530
  }
 ],
 "dbRows": 18
}
```

</details>

<details><summary>op-without-join</summary>

```json
{
 "persisted": true,
 "memberReceived": [
  "chat",
  "op"
 ],
 "outsiderReplies": [
  "op_ack"
 ]
}
```

</details>

<details><summary>oversized-110mib-valid</summary>

```json
{
 "frameBytes": 115343514,
 "acked": false,
 "persisted": false,
 "attackerCloseCode": 1009,
 "errorFrames": 0,
 "rssBeforeMb": 117.84375,
 "rssPeakMb": 189.515625,
 "logBytesAdded": 1107,
 "bystanderWorstAckMs": 28.22845800000141,
 "bystanderSamples": 120
}
```

</details>

<details><summary>oversized-1mib-valid</summary>

```json
{
 "frameBytes": 1048730,
 "acked": true,
 "persisted": true,
 "attackerCloseCode": null,
 "errorFrames": 0,
 "rssBeforeMb": 117.953125,
 "rssPeakMb": 138.0625,
 "logBytesAdded": 0,
 "bystanderWorstAckMs": 44.53904199999988,
 "bystanderSamples": 104
}
```

</details>

<details><summary>oversized-64mib-invalid</summary>

```json
{
 "frameBytes": 67108942,
 "acked": false,
 "persisted": false,
 "attackerCloseCode": null,
 "errorFrames": 0,
 "rssBeforeMb": 119.15625,
 "rssPeakMb": 509.203125,
 "logBytesAdded": 67109312,
 "bystanderWorstAckMs": 446.6995420000003,
 "bystanderSamples": 448
}
```

</details>

<details><summary>oversized-64mib-valid</summary>

```json
{
 "frameBytes": 67109018,
 "acked": true,
 "persisted": true,
 "attackerCloseCode": null,
 "errorFrames": 0,
 "rssBeforeMb": 117.78125,
 "rssPeakMb": 706.90625,
 "logBytesAdded": 0,
 "bystanderWorstAckMs": 515.4804999999997,
 "bystanderSamples": 103
}
```

</details>

<details><summary>oversized-8mib-valid</summary>

```json
{
 "frameBytes": 8388762,
 "acked": true,
 "persisted": true,
 "attackerCloseCode": null,
 "errorFrames": 0,
 "rssBeforeMb": 117.84375,
 "rssPeakMb": 205.78125,
 "logBytesAdded": 0,
 "bystanderWorstAckMs": 59.25904199999968,
 "bystanderSamples": 106
}
```

</details>

<details><summary>reconnect-mid-burst</summary>

```json
{
 "cycles": 8,
 "victimSent": 2269,
 "victimAcked": 2266,
 "persistedButNeverAcked": 3,
 "droppedUnacked": 0,
 "sessionDiffs": [
  {
   "entries": 471,
   "maxSeen": 454,
   "missing": 0,
   "duplicates": 17
  },
  {
   "entries": 918,
   "maxSeen": 918,
   "missing": 0,
   "duplicates": 0
  },
  {
   "entries": 1392,
   "maxSeen": 1391,
   "missing": 0,
   "duplicates": 1
  },
  {
   "entries": 1861,
   "maxSeen": 1860,
   "missing": 0,
   "duplicates": 1
  },
  {
   "entries": 2328,
   "maxSeen": 2328,
   "missing": 0,
   "duplicates": 0
  },
  {
   "entries": 2793,
   "maxSeen": 2793,
   "missing": 0,
   "duplicates": 0
  },
  {
   "entries": 3258,
   "maxSeen": 3258,
   "missing": 0,
   "duplicates": 0
  },
  {
   "entries": 3732,
   "maxSeen": 3731,
   "missing": 0,
   "duplicates": 1
  },
  {
   "entries": 3895,
   "maxSeen": 3895,
   "missing": 0,
   "duplicates": 0
  }
 ],
 "dbRows": 3895
}
```

</details>

<details><summary>restart-sigkill</summary>

```json
{
 "closeCodes": [
  1006,
  1006,
  1006
 ],
 "allClosedMs": 24.911999999999807,
 "exitBeforeRestart": {
  "code": null,
  "signal": "SIGKILL"
 },
 "ackedBeforeKill": 1888,
 "rowsWhenDown": 1888,
 "persistedButNeverAcked": 0,
 "ackedAfterRestart": 1916,
 "sessionDiffs": [
  {
   "entries": 3804,
   "maxSeen": 3804,
   "missing": 0,
   "duplicates": 0
  },
  {
   "entries": 3804,
   "maxSeen": 3804,
   "missing": 0,
   "duplicates": 0
  },
  {
   "entries": 3804,
   "maxSeen": 3804,
   "missing": 0,
   "duplicates": 0
  }
 ]
}
```

</details>

<details><summary>restart-sigterm</summary>

```json
{
 "closeCodes": [
  1006,
  1006,
  1006
 ],
 "allClosedMs": 16.21733299999869,
 "exitBeforeRestart": {
  "code": null,
  "signal": "SIGTERM"
 },
 "ackedBeforeKill": 1871,
 "rowsWhenDown": 1871,
 "persistedButNeverAcked": 0,
 "ackedAfterRestart": 1924,
 "sessionDiffs": [
  {
   "entries": 3795,
   "maxSeen": 3795,
   "missing": 0,
   "duplicates": 0
  },
  {
   "entries": 3795,
   "maxSeen": 3795,
   "missing": 0,
   "duplicates": 0
  },
  {
   "entries": 3795,
   "maxSeen": 3795,
   "missing": 0,
   "duplicates": 0
  }
 ]
}
```

</details>

<details><summary>slow-consumer</summary>

```json
{
 "load": {
  "opBytes": 32768,
  "opsPerSecond": 100,
  "runMs": 75000
 },
 "control": {
  "alive": true,
  "exit": null,
  "opsPersisted": 7048,
  "writerAckP50Ms": 11.012291999999434,
  "writerAckP99Ms": 20.53079200000502,
  "peakBufferedMb": 0,
  "peakBufferedAtSec": 0,
  "bufferDroppedAtSec": null,
  "rssStartMb": 138.3125,
  "rssPeakMb": 330.359375,
  "slowCloseCode": null,
  "bufferedSeries": [
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0,
   0
  ],
  "rssSeries": [
   138,
   249,
   303,
   323,
   324,
   326,
   329,
   330,
   330,
   330,
   330,
   330,
   323,
   323,
   323,
   323
  ],
  "peakBuffered": 0
 },
 "slowConsumer": {
  "alive": true,
  "exit": null,
  "opsPersisted": 7036,
  "writerAckP50Ms": 11.019082999991952,
  "writerAckP99Ms": 21.493333999998868,
  "peakBufferedMb": 175.20227146148682,
  "peakBufferedAtSec": 59,
  "bufferDroppedAtSec": 60,
  "rssStartMb": 137.21875,
  "rssPeakMb": 609.609375,
  "slowCloseCode": null,
  "bufferedSeries": [
   1,
   16,
   31,
   45,
   60,
   75,
   90,
   104,
   119,
   134,
   149,
   163,
   0,
   0,
   0,
   0
  ],
  "rssSeries": [
   137,
   282,
   342,
   370,
   394,
   446,
   496,
   499,
   431,
   469,
   478,
   539,
   609,
   603,
   584,
   566
  ],
  "peakBuffered": 183712897
 }
}
```

</details>

<details><summary>two-rooms</summary>

```json
{
 "rowsA": 6967,
 "rowsB": 6966,
 "inversionsA": 0,
 "inversionsB": 0
}
```

</details>

<details><summary>unknown-room-chat-over-int4</summary>

```json
{
 "replies": [],
 "exit": null,
 "clientCloseCode": null,
 "bystanderCloseCode": null
}
```

</details>

<details><summary>unknown-room-chat-unknown</summary>

```json
{
 "replies": [],
 "exit": null,
 "clientCloseCode": null,
 "bystanderCloseCode": null
}
```

</details>

<details><summary>unknown-room-join-negative</summary>

```json
{
 "replies": [],
 "exit": null,
 "clientCloseCode": null,
 "bystanderCloseCode": null
}
```

</details>

<details><summary>unknown-room-join-over-int4</summary>

```json
{
 "replies": [],
 "exit": {
  "code": 1,
  "signal": null
 },
 "clientCloseCode": 1006,
 "bystanderCloseCode": 1006
}
```

</details>

<details><summary>unknown-room-join-unknown</summary>

```json
{
 "replies": [],
 "exit": null,
 "clientCloseCode": null,
 "bystanderCloseCode": null
}
```

</details>

<details><summary>unknown-room-leave-unknown</summary>

```json
{
 "replies": [],
 "exit": null,
 "clientCloseCode": null,
 "bystanderCloseCode": null
}
```

</details>

<details><summary>unknown-room-op-over-int4</summary>

```json
{
 "replies": [
  "error"
 ],
 "exit": null,
 "clientCloseCode": null,
 "bystanderCloseCode": null
}
```

</details>

<details><summary>unknown-room-op-unknown</summary>

```json
{
 "replies": [
  "error"
 ],
 "exit": null,
 "clientCloseCode": null,
 "bystanderCloseCode": null
}
```

</details>


### Throughput: `before-fullfsync`

Commit `4225f362bd6bf13e122da15f1095cfd94f802727`, Apple M1 Pro, 10 cores, 16 GB, darwin 27.0.0, Node v24.14.1. Postgres 17.10 (Homebrew): fsync=on, synchronous_commit=on, wal_sync_method=fsync_writethrough. 60s measured after 5s warm-up, fresh server and room per run.

| mode | clients | rep | acked/s | worst 1s | p50 ms | p95 ms | p99 ms | max ms | errors | unacked | server CPU | PG CPU | harness ELU |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 5 | 1 | 180.3 | 152 | 24.1 | 53.0 | 75.2 | 176.7 | 0 | 0 | 0.25 | 0.19 | 0.07 |
| closed | 20 | 1 | 177.4 | 139 | 100.1 | 203.3 | 282.6 | 518.0 | 0 | 0 | 0.24 | 0.21 | 0.09 |
| closed | 50 | 1 | 165.7 | 95 | 290.4 | 424.1 | 534.8 | 817.6 | 0 | 0 | 0.27 | 0.18 | 0.12 |
| open:800 | 5 | 1 | 181.0 | 0 | 2042.0 | 2138.0 | 2197.9 | 2434.9 | 39904 | 39904 | 0.31 | 0.21 | 0.05 |
| open:800 | 20 | 1 | 189.2 | 0 | 2039.7 | 2129.5 | 2198.3 | 2432.2 | 39360 | 39360 | 0.28 | 0.18 | 0.05 |
| open:800 | 50 | 1 | 162.5 | 0 | 2045.4 | 2152.1 | 2238.2 | 3899.1 | 41219 | 41219 | 0.37 | 0.19 | 0.11 |
| closed | 5 | 2 | 167.1 | 130 | 26.1 | 58.4 | 85.3 | 229.6 | 0 | 0 | 0.24 | 0.18 | 0.07 |
| closed | 20 | 2 | 139.5 | 83 | 128.1 | 259.2 | 365.9 | 734.7 | 0 | 0 | 0.25 | 0.19 | 0.15 |
| closed | 50 | 2 | 121.6 | 65 | 395.4 | 593.9 | 801.5 | 1152.6 | 0 | 0 | 0.22 | 0.14 | 0.16 |
| open:800 | 5 | 2 | 148.4 | 0 | 2050.3 | 2152.1 | 2247.6 | 2681.5 | 42045 | 42045 | 0.36 | 0.20 | 0.13 |
| open:800 | 20 | 2 | 152.6 | 0 | 2049.1 | 2153.6 | 2226.4 | 2441.4 | 41720 | 41720 | 0.35 | 0.19 | 0.13 |
| open:800 | 50 | 2 | 147.7 | 0 | 2050.5 | 2158.8 | 2248.3 | 2564.6 | 42092 | 42092 | 0.42 | 0.21 | 0.13 |
| closed | 5 | 3 | 150.6 | 113 | 29.6 | 65.3 | 89.8 | 265.0 | 0 | 0 | 0.24 | 0.18 | 0.10 |
| closed | 20 | 3 | 144.6 | 110 | 125.3 | 251.8 | 332.6 | 511.3 | 0 | 0 | 0.25 | 0.21 | 0.14 |
| closed | 50 | 3 | 143.2 | 116 | 342.5 | 476.3 | 576.3 | 945.0 | 0 | 0 | 0.27 | 0.19 | 0.15 |
| open:800 | 5 | 3 | 153.3 | 0 | 2048.4 | 2155.9 | 2236.0 | 2393.9 | 41652 | 41652 | 0.39 | 0.24 | 0.10 |
| open:800 | 20 | 3 | 155.8 | 0 | 2047.7 | 2156.9 | 2235.8 | 2532.6 | 41519 | 41519 | 0.40 | 0.23 | 0.10 |
| open:800 | 50 | 3 | 141.8 | 0 | 2051.3 | 2171.0 | 2280.3 | 2718.9 | 42366 | 42366 | 0.43 | 0.21 | 0.12 |

Median across reps:

| mode | clients | reps | acked/s | worst 1s | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| closed | 5 | 3 | 167.1 | 130 | 26.1 | 58.4 | 85.3 |
| closed | 20 | 3 | 144.6 | 110 | 125.3 | 251.8 | 332.6 |
| closed | 50 | 3 | 143.2 | 95 | 342.5 | 476.3 | 576.3 |
| open:800 | 5 | 3 | 153.3 | 0 | 2048.4 | 2152.1 | 2236.0 |
| open:800 | 20 | 3 | 155.8 | 0 | 2047.7 | 2153.6 | 2226.4 |
| open:800 | 50 | 3 | 147.7 | 0 | 2050.5 | 2158.8 | 2248.3 |

Convergence (arrival order compares all clients; inversions are seqs arriving after a higher seq):

| mode | clients | rep | same arrival order | content = DB | clients with inversions | max inversions | gaps | dups | DB contiguous | currentSeq = max | DB rows | persist failures | crashed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 5 | 1 | true | true | 0/5 | 0 | 0 | 0 | true | true | 11625 | 0 | false |
| closed | 20 | 1 | true | true | 0/20 | 0 | 0 | 0 | true | true | 11454 | 0 | false |
| closed | 50 | 1 | true | true | 0/50 | 0 | 0 | 0 | true | true | 10777 | 0 | false |
| open:800 | 5 | 1 | true | true | 0/5 | 0 | 0 | 0 | true | true | 12096 | 39904 | false |
| open:800 | 20 | 1 | true | true | 0/20 | 0 | 0 | 0 | true | true | 12640 | 39360 | false |
| open:800 | 50 | 1 | true | true | 0/50 | 0 | 0 | 0 | true | true | 10781 | 41219 | false |
| closed | 5 | 2 | true | true | 0/5 | 0 | 0 | 0 | true | true | 10918 | 0 | false |
| closed | 20 | 2 | true | true | 0/20 | 0 | 0 | 0 | true | true | 8858 | 0 | false |
| closed | 50 | 2 | true | true | 0/50 | 0 | 0 | 0 | true | true | 8095 | 0 | false |
| open:800 | 5 | 2 | true | true | 0/5 | 0 | 0 | 0 | true | true | 9955 | 42045 | false |
| open:800 | 20 | 2 | true | true | 0/20 | 0 | 0 | 0 | true | true | 10280 | 41720 | false |
| open:800 | 50 | 2 | true | true | 0/50 | 0 | 0 | 0 | true | true | 9908 | 42092 | false |
| closed | 5 | 3 | true | true | 0/5 | 0 | 0 | 0 | true | true | 9751 | 0 | false |
| closed | 20 | 3 | true | true | 0/20 | 0 | 0 | 0 | true | true | 9423 | 0 | false |
| closed | 50 | 3 | true | true | 0/50 | 0 | 0 | 0 | true | true | 9228 | 0 | false |
| open:800 | 5 | 3 | true | true | 0/5 | 0 | 0 | 0 | true | true | 10348 | 41652 | false |
| open:800 | 20 | 3 | true | true | 0/20 | 0 | 0 | 0 | true | true | 10481 | 41519 | false |
| open:800 | 50 | 3 | true | true | 0/50 | 0 | 0 | 0 | true | true | 9634 | 42366 | false |

