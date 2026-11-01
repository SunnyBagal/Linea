# ws-backend load test

Every figure below comes from `packages/loadtest` and is stored in `packages/loadtest/results/`. The findings and Phase 1 baseline below describe the server at `0f574e3`, measured with harness commit `4225f36`. For what changed, jump to [Phase 2](#phase-2-fixes-and-beforeafter), and for open work see [Open issues](#open-issues).

## How to rerun

```sh
pnpm install
cd packages/loadtest
bash run-all.sh <label>           # about 50 minutes: chaos, then throughput twice
FULLFSYNC=0 bash run-all.sh <label>   # about 30 minutes: skips the fsync_writethrough pass
npx tsx src/report.ts <label> <label>-fullfsync
bash run-ab.sh                    # about 20 minutes: original and current server, interleaved
bash run-comparisons.sh           # about 8 minutes: queue cost with slow database replies, plus overload
BASE=<git ref> bash run-group-commit.sh   # about 75 minutes: group commit comparison, interleaved
pnpm e2e                          # about 1 minute: rollback in the real web app, needs Google Chrome
```

Everything runs locally: the real `ws-backend` and `http-backend` builds, plus a throwaway Postgres on `127.0.0.1:55433`. The harness refuses any non-local database URL, gives child processes a minimal explicit env, and applies migrations with `psql` instead of the Prisma CLI.

## Caveats

- **Hardware:** Apple M1 Pro, 10 cores, 16 GB, Node 24.14.1, Postgres 17.10 (Homebrew). This is a Mac, not a container. Server, Postgres and clients share the machine, and other apps may have been running.
- **Not production:** nothing here measures Neon or Railway. Localhost has almost no network latency, while each op holds the room's row lock across several database round trips. Production capacity could be much lower, and this harness does not measure it.
- **Disk flush dominates:** by default macOS Postgres (`wal_sync_method=open_datasync`) doesn't force the drive cache to flush. `fsync_writethrough` does. Both are reported because they differ by about 20x. Neither stands in for production storage.
- **Harness load:** the busiest client worker reached an event-loop utilization of 0.29, so the harness was not the bottleneck.
- **Variance:** the first repetition was noticeably worse than the other two in several cells, so look at all three rows and not only the medians.
- **Earlier numbers:** `bench/results` used Docker on macOS and counted an op complete when all observers received it. Here an op is complete when the sender gets `op_ack`. The two sets are not directly comparable.
- **Chaos thresholds are choices, not measurements:** the 1 MiB frame limit, the socket buffer limit (32 MiB in the Phase 1 baseline, 8 MiB from Phase 2), and the expectation that invalid frames get an error reply.

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
| F7 | Medium (was High; see Phase 3) | Overload rejected most ops, and the web client ignored `error` frames. **Fixed in Phase 3** up to the measured rates: group commit, and rollback with a notice. Rejections above capacity remain. | `gc-main-fullfsync` at 800/s: 80.9–82.7% rejected. `gc-new-fullfsync`: 0%. | Done, except what Open issues lists |
| F8 | Medium | Resends are not idempotent. Each resend gets a new row and seq. | `duplicate-resend`: 2 rows for both retry and in-flight double send. The browser doesn't retry today, so this is latent. An op can still persist without an ack (3 of 2269 in `reconnect-mid-burst`). | Large: needs a client op id and a schema change |
| F9 | Medium | `op` and `chat` are accepted from a client that never joined the room. `join_room` itself has no authorization. | `op-without-join`: persisted, acked and broadcast | Small for membership; authorization is a product decision |
| F10 | Low | No SIGTERM handling, so deploys close clients with 1006 and drop in-flight work. | `restart-sigterm`: close codes 1006. No acked op was lost. | Small |
| F11 | Fixed in Phase 3 | The web catch-up flow could add the same op to its log twice, and could miss ops because it fetched before `join_room` took effect. | `catchup-late-join`, `catchup-slow-fetch`, `reconnect-mid-burst` | Done |
| F12 | Low | Failures are silent: no reply to malformed frames, unknown-room joins or failed chats. | `malformed-json`, `unknown-room-*` | Small |

## What held up

- **Room isolation:** no cross-talk in `two-rooms`, about 7,000 ops per room, and a client in both rooms saw both streams complete.
- **Crash durability:** in `restart-sigkill` and `restart-sigterm` every acked op survived with its seq, seqs continued after the restart, and reconnected clients matched the database.
- **Bad input:** 18 malformed frames caused no crash and the connection recovered after each. Failed ops did not burn seq numbers.
- **Unknown rooms:** `op` to an unknown or out-of-range room returns an `error` frame and the server stays up.
- **Over 100 MiB:** a 110 MiB frame is closed with 1009.
- **Abrupt disconnects:** no missing ops in this baseline run of `reconnect-mid-burst`. **Corrected in Phase 2:** repeated runs did reproduce the fetch-before-join gap, on the original server too (see F11).

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

## Phase 2: fixes and before/after

Decisions on limits and scope came from the project owner: 1 MiB frames, disconnect at 8 MiB buffered, F7 and F8 left open, joined-before-write only for F9, no `apps/web` changes, and one new protocol reply (an `error` frame on a failed `join_room`).

### What changed

| Finding | Commit | Fix | Before | After |
|---|---|---|---|---|
| F1, F2 | `8b6a2c6` | Catch `join_room` failures and reply with an `error` frame | Server exits with code 1 | Server stays up, sender gets `error` |
| F3 | `5aef400` | 1 MiB frame limit, closed with 1009 | 64 MiB op persisted, RSS peak 707 MB | Closed with 1009, not persisted, RSS peak 130 MB |
| F4 | `a0ec204` | Log frame size and at most 3 issues | 900,447 log bytes from a 900 KB frame | 166 log bytes |
| F5 | `bf88949` | Disconnect at 8 MiB buffered | 175 MiB on one socket, evicted at 60 s, RSS peak 610 MB | 6.9 MiB sampled peak, evicted within 3 s, RSS peak 189 MB |
| F6 | `10a679a` | Per-room queue for commit, broadcast and ack, with a 2 s wait limit | Inversions in 5 of 18 runs | Inversions in 0 of 18 runs |
| F9 | `8b2a6b1` | Require `join_room` before `op` and `chat` | Non-member op persisted and broadcast | Op gets the existing `error` frame, chat is dropped |
| F10 | `96c9a88` | Drain and exit on SIGTERM and SIGINT | Close code 1006, killed by signal | Close code 1001, exit code 0 |

Every regression test was seen failing without its fix, except `ordering-backlog`, which guards the new wait limit and passes either way. The `ordering-jitter` test uses a proxy that delays database replies at random; it failed 3 of 3 runs without F6 (1, 4 and 7 inversions, development runs not stored in `results/`) and passed 3 of 3 with it, while the 60 s load runs only hit the race sometimes.

### Chaos suite

Baseline: 15 of 22 tests failed. Now: 5 of 26 fail, all in findings deliberately left open.

| Still failing | Finding | Why it stays |
|---|---|---|
| `duplicate op resend is idempotent` | F8 | Out of scope, see Open issues |
| `client disconnects mid-burst and reconnects` | F11 | Needs an `apps/web` change |
| `malformed frames ...` | F12 | Would need new protocol replies |
| `unknown room: chat-unknown` | F12 | Would need new protocol replies |
| `unknown room: chat-over-int4` | F12 | Would need new protocol replies |

### Throughput: the fixes have a cost

Default sync, 60 s runs, median of 3. Baseline and fixed were measured in separate sessions, so treat this table as an upper bound on the change; the interleaved table below is the fairer comparison.

| Mode | Clients | Before acked/s | After acked/s | Before p50 / p95 / p99 ms | After p50 / p95 / p99 ms | After errors |
|---|---|---|---|---|---|---|
| closed | 5 | 3591.4 | 2023.2 | 1.3 / 2.4 / 3.5 | 2.2 / 3.9 / 6.8 | 0 |
| closed | 20 | 2383.6 | 1583.7 | 7.4 / 14.9 / 20.4 | 10.4 / 20.0 / 35.8 | 0 |
| closed | 50 | 1780.8 | 1263.5 | 26.7 / 37.9 / 46.5 | 33.6 / 62.2 / 104.0 | 0 |
| open:800 | 5 | 800.0 | 800.0 | 2.3 / 4.0 / 4.8 | 2.8 / 142.0 / 497.7 | 0 |
| open:800 | 20 | 800.0 | 800.0 | 2.3 / 4.2 / 5.1 | 3.0 / 33.0 / 177.1 | 0 |
| open:800 | 50 | 800.0 | 800.0 | 2.5 / 4.2 / 5.3 | 2.8 / 80.6 / 349.5 | 0 |

Correctness in all 18 runs after the fixes: no gaps, no duplicates, no inversions, contiguous database seqs, identical arrival order, content matching the database, no errors, no crashes, and no client disconnected by the 8 MiB limit.

**Interleaved comparison** (`run-ab.sh`): original server `0f574e3` and the fixed server alternated on one Postgres in one session, 30 s runs, 3 each.

| Mode | Clients | Original acked/s (runs) | Fixed acked/s (runs) | Original p95 range ms | Fixed p95 range ms | Original p99 range ms | Fixed p99 range ms |
|---|---|---|---|---|---|---|---|
| closed | 5 | 2920.8 (2754, 3189, 2921) | 2213.4 (2602, 2213, 2025) | 2.9–3.7 | 2.5–3.7 | 4.7–6.1 | 3.9–6.4 |
| closed | 50 | 1632.5 (1632, 1669, 1367) | 1363.4 (1363, 1339, 1639) | 40.3–60.6 | 41.3–60.9 | 50.4–102.2 | 53.3–103.6 |
| open:800 | 5 | 800.0 | 800.0 | 4.5–6.1 | 4.8–431.6 | 8.9–24.8 | 16.8–588.8 |
| open:800 | 50 | 800.0 | 800.0 | 4.9–117.6 | 4.9–214.7 | 48.5–553.0 | 8.3–461.8 |

What this supports:

- **Capacity:** with fast local commits the fixed server's median is 24% lower at 5 clients and 16% lower at 50. The ranges overlap at 50 clients, and three runs is a small sample. The larger 29–44% drop in the first table is partly drift between sessions.
- **800/s still sustained:** every run reached 800.0 acked/s with no errors, but the tail is unstable on both servers. Spikes appear on the original too, so they aren't caused only by the queue. In these runs the fixed server's worst p95 values are higher. Three runs can't settle how much of that is the queue.
- **With slow database replies the cost is large:** see below.

### The queue costs about half the throughput when database replies are slow

`run-comparisons.sh`: closed loop, 20 clients, 30 s, 3 runs, 5 ms added to every database reply through a local proxy. The "before F6" server is `bf88949`.

| Server | Acked/s (runs) | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|
| Before F6 | 79.5 (79.5, 79.6, 77.1) | 224.0 | 448.9 | 611.4 |
| With F6 | 40.5 (39.9, 40.5, 40.5) | 493.1 | 525.9 | 649.4 |

Before F6, the next transaction could take the row lock as soon as Postgres applied a commit. Now it waits for the commit reply to reach Node first, and that wait grows with network latency. **This matters for production, since Railway to Neon has real latency that this harness does not measure.** 5 ms is an illustrative delay, not a measurement of that link. The F7 design below would remove most of these round trips.

### F11: missing ops on reconnect

The Phase 1 report said the fetch-before-join gap did not reproduce. It does. In 8 interleaved runs of `reconnect-mid-burst`, the original server had 1 run with 5 missing ops and the fixed server had none; the `after` chaos run on the fixed server had 2 missing ops. So the gap exists on both and is not caused by these fixes, and these counts are too small to compare the servers. A client that hits it keeps the gap until it reloads. The fix belongs in `apps/web`: wait until the join has taken effect before fetching, and dedupe by seq. A join-success reply from the server would make that clean, but it is a new protocol reply and was left out of this work.

## Phase 3: group commit, client rollback and exact catch-up

### How the web client generates ops

Read from `apps/web/app/components/canvas/CanvasBoard.tsx`; these rates are estimates, not measurements. It sends one op per finished gesture, never per pointer move: `CREATE` on mouse up (a pencil stroke carries all its simplified points in one op), `UPDATE` when a drag ends, `CREATE` when text is committed, `DELETE` per key press, and one op per undo. Moving, panning and zooming send nothing.

Assumed rates: 0.5–2 ops/s sustained per actively drawing user, 3–5 ops/s in bursts, and about 30 ops/s while Ctrl+Z is held, until the undo stack is empty.

### Group commit

The room queue now drains pending ops into one SQL statement: one `currentSeq` bump of N plus a multi-row insert, capped at 100 ops and 4 MiB of payload. Ops that arrive during a commit form the next batch, so nothing waits when the room is idle. If a batch fails, its ops are retried one at a time, so one bad op can't fail the others.

`group-commit-round-trips` confirms a lone op gets one database reply, where the old transaction took several.

Interleaved against `b6dcf29` (main), 3 reps, medians. Run with `BASE=b6dcf29 bash run-group-commit.sh`. Both labels record the same harness commit, `dc6ccfb`; the script swaps only the server source. Default sync cells ran for 60 s, the others for 30 s.

**Default sync (`open_datasync`), closed loop:**

| clients | main acked/s | new acked/s | main p95 ms | new p95 ms | new ops per commit |
|---|---|---|---|---|---|
| 5 | 2652 | 6901 | 2.5 | 0.9 | 2.50 |
| 20 | 2214 | 5706 | 12.9 | 4.3 | 9.98 |
| 50 | 1733 | 3716 | 35.5 | 15.2 | 24.69 |

**Default sync, 800/s offered:**

| clients | main acked/s | new acked/s | main p95 / p99 ms | new p95 / p99 ms | errors, both |
|---|---|---|---|---|---|
| 5 | 800 | 800 | 4.3 / 15.5 | 5.2 / 9.0 | 0 |
| 20 | 800 | 800 | 4.8 / 10.7 | 4.5 / 7.0 | 0 |
| 50 | 800 | 800 | 4.8 / 22.6 | 4.6 / 7.9 | 0 |

**5 ms added to each database reply, closed loop:**

| clients | main acked/s | new acked/s | main p95 ms | new p95 ms | new ops per commit |
|---|---|---|---|---|---|
| 5 | 30.2 | 256 | 185 | 24.9 | 2.48 |
| 20 | 30.2 | 894 | 726 | 27.1 | 9.89 |
| 50 | 28.8 | 1906 | 1883 | 27.4 | 24.32 |

**5 ms added, 800/s offered:**

| clients | main acked/s | new acked/s | main errors per run | new errors | main p95 ms | new p95 ms |
|---|---|---|---|---|---|---|
| 5 | 27.5 | 800 | 26955–26983 | 0 | 2041 | 24.4 |
| 20 | 27.5 | 800 | 26974–26992 | 0 | 2041 | 27.1 |
| 50 | 27.5 | 800 | 26968–26980 | 0 | 2041 | 31.1 |

**`fsync_writethrough`, 20 clients:**

| mode | main acked/s | new acked/s | main errors per run | new errors | main p95 ms | new p95 ms |
|---|---|---|---|---|---|---|
| closed | 134.5 | 1349 | 0 | 0 | 185.5 | 20.8 |
| 800/s offered | 133.2 | 800 | 22650–23151 (80.9–82.7% of 28,000) | 0 | 2013 | 20.3 |

**Correctness:** all 72 cells passed, on both servers: same arrival order on every client, content equal to the database, 0 inversions, gaps and duplicates, seqs contiguous from 1, `currentSeq` equal to the max seq, no crashes. On the new server, every op sent was acked, with no persist failures. The main server's errors at 800/s are its 2 s queue limit.

How to read these:

- **The limit has moved.** On the new server at 50 clients in closed loop, the server used 0.91 of a core and Postgres 0.10, so Node's single thread now limits throughput, not the database. That is why throughput falls as clients rise: each op is sent to every client in the room. The harness stayed under saturation, with a peak worker event loop utilization of 0.57.
- **800/s with no added latency is not a capacity gain.** Main already kept up there. Tail latency improved at 800/s, but p95 at 5 clients was slightly worse, and with 3 reps these differences are small enough to be noise.
- **Spread between reps.** With 5 ms added and 20 clients, the new server's reps were 888, 894 and 1163 acked/s. Treat ratios as rough.
- **Earlier runs.** `after-dbdelay5` measured 40.5/s where `gc-main-delay5` measured 30.2/s at 20 clients on the same code path, in a different session. Compare within this interleaved run only.
- **Not production.** This is an Apple M1 Pro laptop with local Postgres, running directly on macOS rather than in a container, and the 5 ms is injected by a local proxy on replies only. Production capacity is still unmeasured.

The finished build (with the Phase 2 changes below) got one 30 s rep of each, as `phase2-final` and `phase2-final-nodelay`. They match the tables: 262, 968 and 1888 acked/s closed loop with 5 ms added, 6434, 5807 and 3816 with none, 800/s with 0 errors in every open-loop cell, and all correctness checks passing. One rep shows no regression; it isn't a new comparison.

### F11: exact catch-up

The server now adds the client to the room, reads `currentSeq`, and replies `{ type: 'room_joined', roomId, seq }`. Ops above that seq always reach the client as broadcasts, because they commit after it became a member. Ops up to it are already in the database. So the client buffers frames, fetches after the reply, refetches if the result is behind `seq`, and merges by seq.

`catchup-late-join` and `catchup-slow-fetch` run the old and new flows in turn under the same conditions, 6 sessions each, with a writer running. The conditions are forced (a join frame held back 100 ms, or 150 ms added to the HTTP backend's database replies), so the counts show the mechanism and not a production rate. `FetchBeforeJoinSession` in `test/helpers.ts` copies the old flow; `BrowserSession` runs the web client's own merge code from `apps/web/lib/canvas/oplog.ts`.

| case | old flow, 4 runs | new flow, 4 runs |
|---|---|---|
| late join: missing ops | 49, 49, 50, 49 | 0, 0, 0, 0 |
| slow fetch: duplicate entries | 27, 26, 26, 27 | 0, 0, 0, 0 |

`reconnect-mid-burst`, the F11 chaos test, passed all 4 runs with 0 missing and 0 duplicates across all sessions. The restart tests use the new flow too and pass.

### F7 on the client: rollback and notice

`error` frames for ops now carry `roomId`, `shapeId` and `opType`, which is additive. The web client removes the rejected op from its log, refolds the shapes, removes the undo step that op added (or puts back the step if the op was itself an undo), clears the selection if the shape is gone, and shows a small notice that doesn't block the canvas and clears itself after 4 s.

`e2e/rollback.e2e.ts` (`pnpm e2e`) drives the real web app in Chrome against the local backends, using a database constraint to make inserts fail. Its 13 checks cover rejected `CREATE`, undo and drag, each restoring the canvas pixel for pixel; the notice appearing and clearing; retrying a rejected undo; the database holding only accepted ops; and a watching tab and a newly opened tab matching the author's pixels exactly. `test/oplog.test.ts` covers the log rules and `test/error-frames.test.ts` the frames.

The in-progress shape preview leaves `lineCap` and `lineJoin` set to `round` on the canvas context, so a tab that has drawn a shape renders line ends a few pixels differently from one that hasn't. This was already there and is only cosmetic. The browser test sets the same values on the other tabs before comparing.

### Chaos run on the finished build

`phase2-chaos`: 44 of 49 tests passed on the first run, plus the browser test. One failure was a stale check in `op-without-join`, which required a member to receive no frames at all and now sees its `room_joined`. The check now looks for `op` and `chat` frames and passes. That leaves 4 known failures:

| test | issue |
|---|---|
| `duplicate op resend is idempotent` | F8 |
| `malformed frames leave the server and the connection usable` | F12 |
| `unknown room: chat-unknown` | F12 |
| `unknown room: chat-over-int4` | F12 |

### Deploy order

Deploy `ws-backend` first. An old web client ignores `room_joined` and the extra error fields, so it behaves as it does today. A new web client on an old server waits 3 s for a reply it won't get, then loads as it used to; it can't roll back, and an op error shows the "Couldn't connect to this canvas" notice instead.

## Open issues

### F7: what's left

**Status:** mostly fixed in Phase 3. Medium severity for what remains.

Steps 1, 2 and 4 of the original design are done, and step 3 is done differently: error frames name the shape and op type instead of a client op id, which F8 would add. What remains:

- **Above capacity, ops are still rejected.** The 2 s queue limit and the rejection path are unchanged. No run here pushed offered load past capacity on the new server: 800/s was sustained with 0 errors in every configuration.
- **A rejected change is lost.** The client rolls it back and says so, but doesn't retry. Safe retries need F8.
- **Ops unanswered when a socket drops are dropped without a notice.** The catch-up fetch brings back any that were saved. Any that weren't simply disappear. `reconnect-mid-burst` measured 0 of these in all 4 runs, and 1–3 ops per run that were saved but never acked.
- **Frames that fail validation get no reply (F12),** so an optimistic op in such a frame stays on screen until reload.

### F8: resent ops create duplicates

**Status:** open, medium severity. Latent, because the browser doesn't retry today, but any retry logic would hit it.

**Repro:**

```sh
cd packages/loadtest
bash pg.sh up
pnpm --filter ws-backend build
LOADTEST_LABEL=f8-repro node --import tsx --test test/duplicate.test.ts
```

**Measured:** sending the same frame twice produces 2 rows and 2 seqs, whether the retry comes after the ack or both are in flight. `shapeId` can't be the dedupe key, because a shape legitimately gets many ops. Clients do need retries: ops can persist without the sender getting an ack (1–19 of about 2,250 per run in `reconnect-mid-burst` on the original server, up to 37 on the fixed server), so a client can't tell a lost op from a lost ack.

**Proposed design:**

1. **Protocol:** add an optional `clientOpId` (UUID) to `op` frames, and echo it in `op_ack` and `error`.
2. **Schema:** add a nullable `Operation.clientOpId` with a unique index on `(roomId, clientOpId)`. Nullable keeps old clients and existing rows working, and Postgres allows many NULLs in a unique index.
3. **Server:** inside the same statement or transaction as the seq increment, look for the existing row first. A resend gets a repeat ack with the original seq and is not broadcast again. It must not consume a seq, or the log gets gaps.
4. **Client:** generate the id in `emitOp`, keep unacked ops, and resend them after reconnect and catch-up.

The client op id would also let `error` frames name an op exactly, in place of the shape and op type they carry now.

## Raw results: Phase 2

### Throughput: `after`

Commit `ce2deb374ded08db568d9b79653d1c1f5b85cc5c`, Apple M1 Pro, 10 cores, 16 GB, darwin 27.0.0, Node v24.14.1. Postgres 17.10 (Homebrew): fsync=on, synchronous_commit=on, wal_sync_method=open_datasync. 60s measured after 5s warm-up, fresh server and room per run.

| mode | clients | rep | acked/s | worst 1s | p50 ms | p95 ms | p99 ms | max ms | errors | unacked | server CPU | PG CPU | harness ELU |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 5 | 1 | 1610.9 | 432 | 2.5 | 5.5 | 12.0 | 363.2 | 0 | 0 | 0.57 | 0.33 | 0.12 |
| closed | 20 | 1 | 1474.8 | 810 | 12.1 | 20.0 | 35.8 | 225.9 | 0 | 0 | 0.63 | 0.32 | 0.16 |
| closed | 50 | 1 | 1155.0 | 753 | 40.6 | 62.2 | 102.4 | 255.0 | 0 | 0 | 0.68 | 0.28 | 0.24 |
| open:800 | 5 | 1 | 800.0 | 632 | 2.8 | 142.0 | 497.7 | 818.4 | 0 | 0 | 0.33 | 0.20 | 0.09 |
| open:800 | 20 | 1 | 800.0 | 530 | 3.2 | 73.5 | 177.1 | 367.0 | 0 | 0 | 0.38 | 0.20 | 0.11 |
| open:800 | 50 | 1 | 800.0 | 362 | 2.8 | 368.2 | 626.8 | 1695.7 | 0 | 0 | 0.43 | 0.17 | 0.18 |
| closed | 5 | 2 | 2023.2 | 517 | 2.2 | 3.9 | 6.8 | 187.1 | 0 | 0 | 0.62 | 0.36 | 0.11 |
| closed | 20 | 2 | 1757.4 | 359 | 10.4 | 15.5 | 24.7 | 387.9 | 0 | 0 | 0.64 | 0.32 | 0.18 |
| closed | 50 | 2 | 1263.5 | 151 | 33.6 | 63.5 | 136.6 | 763.2 | 0 | 0 | 0.67 | 0.25 | 0.26 |
| open:800 | 5 | 2 | 800.0 | 722 | 2.5 | 5.7 | 57.2 | 109.0 | 0 | 0 | 0.30 | 0.19 | 0.07 |
| open:800 | 20 | 2 | 800.0 | 573 | 3.0 | 33.0 | 216.8 | 487.1 | 0 | 0 | 0.35 | 0.18 | 0.09 |
| open:800 | 50 | 2 | 800.0 | 701 | 2.8 | 39.4 | 165.0 | 329.2 | 0 | 0 | 0.44 | 0.17 | 0.18 |
| closed | 5 | 3 | 2365.6 | 1493 | 1.9 | 3.2 | 4.7 | 206.0 | 0 | 0 | 0.62 | 0.36 | 0.11 |
| closed | 20 | 3 | 1583.7 | 420 | 10.1 | 24.1 | 50.2 | 327.9 | 0 | 0 | 0.62 | 0.31 | 0.16 |
| closed | 50 | 3 | 1414.5 | 205 | 31.1 | 52.4 | 104.0 | 568.9 | 0 | 0 | 0.69 | 0.26 | 0.24 |
| open:800 | 5 | 3 | 800.0 | 474 | 2.8 | 211.7 | 555.3 | 846.2 | 0 | 0 | 0.33 | 0.20 | 0.08 |
| open:800 | 20 | 3 | 800.0 | 764 | 2.9 | 12.9 | 72.4 | 158.5 | 0 | 0 | 0.33 | 0.17 | 0.08 |
| open:800 | 50 | 3 | 800.0 | 512 | 2.8 | 80.6 | 349.5 | 505.7 | 0 | 0 | 0.43 | 0.17 | 0.15 |

Median across reps:

| mode | clients | reps | acked/s | worst 1s | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| closed | 5 | 3 | 2023.2 | 517 | 2.2 | 3.9 | 6.8 |
| closed | 20 | 3 | 1583.7 | 420 | 10.4 | 20.0 | 35.8 |
| closed | 50 | 3 | 1263.5 | 205 | 33.6 | 62.2 | 104.0 |
| open:800 | 5 | 3 | 800.0 | 632 | 2.8 | 142.0 | 497.7 |
| open:800 | 20 | 3 | 800.0 | 573 | 3.0 | 33.0 | 177.1 |
| open:800 | 50 | 3 | 800.0 | 512 | 2.8 | 80.6 | 349.5 |

Convergence (arrival order compares all clients; inversions are seqs arriving after a higher seq):

| mode | clients | rep | same arrival order | content = DB | clients with inversions | max inversions | gaps | dups | DB contiguous | currentSeq = max | DB rows | persist failures | crashed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 5 | 1 | true | true | 0/5 | 0 | 0 | 0 | true | true | 103682 | 0 | false |
| closed | 20 | 1 | true | true | 0/20 | 0 | 0 | 0 | true | true | 94733 | 0 | false |
| closed | 50 | 1 | true | true | 0/50 | 0 | 0 | 0 | true | true | 74789 | 0 | false |
| open:800 | 5 | 1 | true | true | 0/5 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| open:800 | 20 | 1 | true | true | 0/20 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| open:800 | 50 | 1 | true | true | 0/50 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| closed | 5 | 2 | true | true | 0/5 | 0 | 0 | 0 | true | true | 125092 | 0 | false |
| closed | 20 | 2 | true | true | 0/20 | 0 | 0 | 0 | true | true | 112559 | 0 | false |
| closed | 50 | 2 | true | true | 0/50 | 0 | 0 | 0 | true | true | 82530 | 0 | false |
| open:800 | 5 | 2 | true | true | 0/5 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| open:800 | 20 | 2 | true | true | 0/20 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| open:800 | 50 | 2 | true | true | 0/50 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| closed | 5 | 3 | true | true | 0/5 | 0 | 0 | 0 | true | true | 152766 | 0 | false |
| closed | 20 | 3 | true | true | 0/20 | 0 | 0 | 0 | true | true | 103812 | 0 | false |
| closed | 50 | 3 | true | true | 0/50 | 0 | 0 | 0 | true | true | 92365 | 0 | false |
| open:800 | 5 | 3 | true | true | 0/5 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| open:800 | 20 | 3 | true | true | 0/20 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| open:800 | 50 | 3 | true | true | 0/50 | 0 | 0 | 0 | true | true | 52000 | 0 | false |

### Chaos: `after`

Commit `ce2deb374ded08db568d9b79653d1c1f5b85cc5c`.

| case | result | failed checks |
|---|---|---|
| db-outage | pass |  |
| duplicate-resend | FAIL | retry after ack creates one row; in-flight double send creates one row; observer sees the retried op once |
| log-amplification | pass |  |
| malformed-json | FAIL | invalid frames get an error reply |
| op-without-join | pass |  |
| ordering-backlog | pass |  |
| ordering-jitter | pass |  |
| oversized-110mib-valid | pass |  |
| oversized-1mib-valid | pass |  |
| oversized-2mib-valid | pass |  |
| oversized-64mib-invalid | pass |  |
| oversized-64mib-valid | pass |  |
| oversized-8mib-valid | pass |  |
| reconnect-mid-burst | FAIL | catch-up leaves no missing ops; catch-up leaves no duplicate ops |
| restart-sigkill | pass |  |
| restart-sigterm | pass |  |
| slow-consumer | pass |  |
| two-rooms | pass |  |
| unknown-room-chat-over-int4 | FAIL | sender is told about the failure |
| unknown-room-chat-unknown | FAIL | sender is told about the failure |
| unknown-room-join-negative | pass |  |
| unknown-room-join-over-int4 | pass |  |
| unknown-room-join-unknown | pass |  |
| unknown-room-leave-unknown | pass |  |
| unknown-room-op-over-int4 | pass |  |
| unknown-room-op-unknown | pass |  |

Measured facts per case:

<details><summary>db-outage</summary>

```json
{
 "errorFrameForOp": true,
 "aliveAfterOpAndChat": true,
 "aliveAfterJoin": true,
 "exitDuringOutage": null,
 "logTail": null
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

<details><summary>log-amplification</summary>

```json
{
 "logBytesAdded": {
  "largeJunkField": 166,
  "manyInvalidPoints": 250
 }
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
   "logBytesAdded": 101
  },
  {
   "name": "json array",
   "replies": [],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 101
  },
  {
   "name": "json number",
   "replies": [],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 101
  },
  {
   "name": "unknown type",
   "replies": [],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 107
  },
  {
   "name": "op with no fields",
   "replies": [],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 208
  },
  {
   "name": "string roomId",
   "replies": [],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 109
  },
  {
   "name": "float roomId",
   "replies": [],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 109
  },
  {
   "name": "bad opType",
   "replies": [],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 110
  },
  {
   "name": "bad payload",
   "replies": [],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 116
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
   "logBytesAdded": 108
  },
  {
   "name": "deep nesting",
   "replies": [],
   "recovered": true,
   "open": true,
   "closeCode": null,
   "logBytesAdded": 106
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
 "persisted": false,
 "memberReceived": [],
 "outsiderReplies": [
  "error"
 ]
}
```

</details>

<details><summary>ordering-backlog</summary>

```json
{
 "sent": 5000,
 "acked": 145,
 "errors": 4856,
 "drainMsAfterLastSend": 2013.3839999999982,
 "recoverMs": 46.27379100000326,
 "peakRssMb": 130.5625
}
```

</details>

<details><summary>ordering-jitter</summary>

```json
{
 "rows": 637,
 "inversionsPerClient": [
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0
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
 "rssBeforeMb": 121.3125,
 "rssPeakMb": 197.5,
 "logBytesAdded": 1107,
 "bystanderWorstAckMs": 334.9236659999988,
 "bystanderSamples": 127
}
```

</details>

<details><summary>oversized-1mib-valid</summary>

```json
{
 "frameBytes": 1047706,
 "acked": true,
 "persisted": true,
 "attackerCloseCode": null,
 "errorFrames": 0,
 "rssBeforeMb": 121.21875,
 "rssPeakMb": 123.1875,
 "logBytesAdded": 0,
 "bystanderWorstAckMs": 35.23683299999993,
 "bystanderSamples": 131
}
```

</details>

<details><summary>oversized-2mib-valid</summary>

```json
{
 "frameBytes": 2097306,
 "acked": false,
 "persisted": false,
 "attackerCloseCode": 1009,
 "errorFrames": 0,
 "rssBeforeMb": 119.25,
 "rssPeakMb": 123.21875,
 "logBytesAdded": 1107,
 "bystanderWorstAckMs": 20.814957999999933,
 "bystanderSamples": 129
}
```

</details>

<details><summary>oversized-64mib-invalid</summary>

```json
{
 "frameBytes": 67108942,
 "acked": false,
 "persisted": false,
 "attackerCloseCode": 1009,
 "errorFrames": 0,
 "rssBeforeMb": 120.046875,
 "rssPeakMb": 163.875,
 "logBytesAdded": 1107,
 "bystanderWorstAckMs": 172.3103749999991,
 "bystanderSamples": 124
}
```

</details>

<details><summary>oversized-64mib-valid</summary>

```json
{
 "frameBytes": 67109018,
 "acked": false,
 "persisted": false,
 "attackerCloseCode": 1009,
 "errorFrames": 0,
 "rssBeforeMb": 121.1875,
 "rssPeakMb": 130.09375,
 "logBytesAdded": 1107,
 "bystanderWorstAckMs": 303.4697499999984,
 "bystanderSamples": 129
}
```

</details>

<details><summary>oversized-8mib-valid</summary>

```json
{
 "frameBytes": 8388762,
 "acked": false,
 "persisted": false,
 "attackerCloseCode": 1009,
 "errorFrames": 0,
 "rssBeforeMb": 118.09375,
 "rssPeakMb": 120.90625,
 "logBytesAdded": 1107,
 "bystanderWorstAckMs": 26.965624999999818,
 "bystanderSamples": 125
}
```

</details>

<details><summary>reconnect-mid-burst</summary>

```json
{
 "cycles": 8,
 "victimSent": 2238,
 "victimAcked": 2201,
 "persistedButNeverAcked": 37,
 "droppedUnacked": 0,
 "sessionDiffs": [
  {
   "entries": 463,
   "maxSeen": 444,
   "missing": 0,
   "duplicates": 19
  },
  {
   "entries": 910,
   "maxSeen": 912,
   "missing": 2,
   "duplicates": 0
  },
  {
   "entries": 1372,
   "maxSeen": 1371,
   "missing": 0,
   "duplicates": 1
  },
  {
   "entries": 1842,
   "maxSeen": 1842,
   "missing": 0,
   "duplicates": 0
  },
  {
   "entries": 2302,
   "maxSeen": 2301,
   "missing": 0,
   "duplicates": 1
  },
  {
   "entries": 2762,
   "maxSeen": 2761,
   "missing": 0,
   "duplicates": 1
  },
  {
   "entries": 3230,
   "maxSeen": 3229,
   "missing": 0,
   "duplicates": 1
  },
  {
   "entries": 3630,
   "maxSeen": 3629,
   "missing": 0,
   "duplicates": 1
  },
  {
   "entries": 3836,
   "maxSeen": 3836,
   "missing": 0,
   "duplicates": 0
  }
 ],
 "dbRows": 3836
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
 "allClosedMs": 8.571542000000136,
 "exitBeforeRestart": {
  "code": null,
  "signal": "SIGKILL"
 },
 "exitMs": 8.604833999999755,
 "ackedBeforeKill": 1836,
 "rowsWhenDown": 1836,
 "persistedButNeverAcked": 0,
 "ackedAfterRestart": 1886,
 "sessionDiffs": [
  {
   "entries": 3722,
   "maxSeen": 3722,
   "missing": 0,
   "duplicates": 0
  },
  {
   "entries": 3722,
   "maxSeen": 3722,
   "missing": 0,
   "duplicates": 0
  },
  {
   "entries": 3722,
   "maxSeen": 3722,
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
  1001,
  1001,
  1001
 ],
 "allClosedMs": 1.7050830000007409,
 "exitBeforeRestart": {
  "code": 0,
  "signal": null
 },
 "exitMs": 13.062041999999565,
 "ackedBeforeKill": 1844,
 "rowsWhenDown": 1844,
 "persistedButNeverAcked": 0,
 "ackedAfterRestart": 1912,
 "sessionDiffs": [
  {
   "entries": 3756,
   "maxSeen": 3756,
   "missing": 0,
   "duplicates": 0
  },
  {
   "entries": 3756,
   "maxSeen": 3756,
   "missing": 0,
   "duplicates": 0
  },
  {
   "entries": 3756,
   "maxSeen": 3756,
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
  "opsPersisted": 6834,
  "writerAckP50Ms": 11.043166999999812,
  "writerAckP99Ms": 1405.1291670000064,
  "peakBufferedMb": 0,
  "peakBufferedAtSec": 0,
  "bufferDroppedAtSec": null,
  "rssStartMb": 136.75,
  "rssPeakMb": 252.15625,
  "slowCloseCode": null,
  "healthyCloseCode": null,
  "writerCloseCode": null,
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
   0
  ],
  "rssSeries": [
   137,
   184,
   239,
   230,
   224,
   176,
   161,
   153,
   153,
   134,
   162,
   138,
   133,
   113,
   208
  ],
  "peakBuffered": 0
 },
 "slowConsumer": {
  "alive": true,
  "exit": null,
  "opsPersisted": 6882,
  "writerAckP50Ms": 11.065333000005921,
  "writerAckP99Ms": 33.04895900000702,
  "peakBufferedMb": 6.947487831115723,
  "peakBufferedAtSec": 2,
  "bufferDroppedAtSec": 3,
  "rssStartMb": 138.390625,
  "rssPeakMb": 189.484375,
  "slowCloseCode": null,
  "healthyCloseCode": null,
  "writerCloseCode": null,
  "bufferedSeries": [
   1,
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
   180,
   142,
   154,
   147,
   157,
   119,
   135,
   155,
   160,
   155,
   147,
   147,
   149,
   155,
   150
  ],
  "peakBuffered": 7284969
 }
}
```

</details>

<details><summary>two-rooms</summary>

```json
{
 "rowsA": 6918,
 "rowsB": 6917,
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
 "replies": [
  "error"
 ],
 "exit": null,
 "clientCloseCode": null,
 "bystanderCloseCode": null
}
```

</details>

<details><summary>unknown-room-join-over-int4</summary>

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

<details><summary>unknown-room-join-unknown</summary>

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


### Throughput: `before-f6-dbdelay5`

Commit `ce2deb374ded08db568d9b79653d1c1f5b85cc5c`, Apple M1 Pro, 10 cores, 16 GB, darwin 27.0.0, Node v24.14.1. Postgres 17.10 (Homebrew): fsync=on, synchronous_commit=on, wal_sync_method=open_datasync. 30s measured after 5s warm-up, fresh server and room per run.

| mode | clients | rep | acked/s | worst 1s | p50 ms | p95 ms | p99 ms | max ms | errors | unacked | server CPU | PG CPU | harness ELU |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 20 | 1 | 79.5 | 57 | 223.0 | 432.9 | 598.9 | 1006.9 | 0 | 0 | 0.08 | 0.06 | 0.01 |
| closed | 20 | 2 | 79.6 | 58 | 224.0 | 448.9 | 611.4 | 815.4 | 0 | 0 | 0.08 | 0.06 | 0.01 |
| closed | 20 | 3 | 77.1 | 58 | 227.2 | 469.7 | 633.8 | 1288.9 | 0 | 0 | 0.09 | 0.07 | 0.02 |

Median across reps:

| mode | clients | reps | acked/s | worst 1s | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| closed | 20 | 3 | 79.5 | 58 | 224.0 | 448.9 | 611.4 |

Convergence (arrival order compares all clients; inversions are seqs arriving after a higher seq):

| mode | clients | rep | same arrival order | content = DB | clients with inversions | max inversions | gaps | dups | DB contiguous | currentSeq = max | DB rows | persist failures | crashed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 20 | 1 | true | true | 0/20 | 0 | 0 | 0 | true | true | 2800 | 0 | false |
| closed | 20 | 2 | true | true | 0/20 | 0 | 0 | 0 | true | true | 2802 | 0 | false |
| closed | 20 | 3 | true | true | 0/20 | 0 | 0 | 0 | true | true | 2732 | 0 | false |

### Throughput: `after-dbdelay5`

Commit `ce2deb374ded08db568d9b79653d1c1f5b85cc5c`, Apple M1 Pro, 10 cores, 16 GB, darwin 27.0.0, Node v24.14.1. Postgres 17.10 (Homebrew): fsync=on, synchronous_commit=on, wal_sync_method=open_datasync. 30s measured after 5s warm-up, fresh server and room per run.

| mode | clients | rep | acked/s | worst 1s | p50 ms | p95 ms | p99 ms | max ms | errors | unacked | server CPU | PG CPU | harness ELU |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 20 | 1 | 39.9 | 21 | 497.6 | 543.3 | 665.4 | 670.4 | 0 | 0 | 0.06 | 0.02 | 0.01 |
| closed | 20 | 2 | 40.5 | 20 | 485.0 | 525.9 | 649.4 | 658.8 | 0 | 0 | 0.05 | 0.02 | 0.01 |
| closed | 20 | 3 | 40.5 | 20 | 493.1 | 512.5 | 522.3 | 524.8 | 0 | 0 | 0.05 | 0.02 | 0.01 |

Median across reps:

| mode | clients | reps | acked/s | worst 1s | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| closed | 20 | 3 | 40.5 | 20 | 493.1 | 525.9 | 649.4 |

Convergence (arrival order compares all clients; inversions are seqs arriving after a higher seq):

| mode | clients | rep | same arrival order | content = DB | clients with inversions | max inversions | gaps | dups | DB contiguous | currentSeq = max | DB rows | persist failures | crashed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 20 | 1 | true | true | 0/20 | 0 | 0 | 0 | true | true | 1415 | 0 | false |
| closed | 20 | 2 | true | true | 0/20 | 0 | 0 | 0 | true | true | 1427 | 0 | false |
| closed | 20 | 3 | true | true | 0/20 | 0 | 0 | 0 | true | true | 1435 | 0 | false |

### Throughput: `after-fullfsync-overload`

Commit `ce2deb374ded08db568d9b79653d1c1f5b85cc5c`, Apple M1 Pro, 10 cores, 16 GB, darwin 27.0.0, Node v24.14.1. Postgres 17.10 (Homebrew): fsync=on, synchronous_commit=on, wal_sync_method=fsync_writethrough. 60s measured after 5s warm-up, fresh server and room per run.

| mode | clients | rep | acked/s | worst 1s | p50 ms | p95 ms | p99 ms | max ms | errors | unacked | server CPU | PG CPU | harness ELU |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| open:800 | 20 | 1 | 154.4 | 0 | 2005.4 | 2012.4 | 2073.5 | 2515.3 | 41665 | 41665 | 0.28 | 0.07 | 0.07 |
| open:800 | 20 | 2 | 145.7 | 0 | 2006.1 | 2011.5 | 2024.3 | 2137.8 | 42152 | 42152 | 0.34 | 0.08 | 0.07 |
| open:800 | 20 | 3 | 136.7 | 0 | 2007.0 | 2012.1 | 2018.7 | 2093.6 | 42848 | 42848 | 0.37 | 0.08 | 0.08 |

Median across reps:

| mode | clients | reps | acked/s | worst 1s | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| open:800 | 20 | 3 | 145.7 | 0 | 2006.1 | 2012.1 | 2024.3 |

Convergence (arrival order compares all clients; inversions are seqs arriving after a higher seq):

| mode | clients | rep | same arrival order | content = DB | clients with inversions | max inversions | gaps | dups | DB contiguous | currentSeq = max | DB rows | persist failures | crashed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| open:800 | 20 | 1 | true | true | 0/20 | 0 | 0 | 0 | true | true | 10335 | 41665 | false |
| open:800 | 20 | 2 | true | true | 0/20 | 0 | 0 | 0 | true | true | 9848 | 42152 | false |
| open:800 | 20 | 3 | true | true | 0/20 | 0 | 0 | 0 | true | true | 9152 | 42848 | false |

### Throughput: `ab-baseline`

Commit `c6d8459bef23f26c46f03d3ffa98778611528907`, Apple M1 Pro, 10 cores, 16 GB, darwin 27.0.0, Node v24.14.1. Postgres 17.10 (Homebrew): fsync=on, synchronous_commit=on, wal_sync_method=open_datasync. 30s measured after 5s warm-up, fresh server and room per run.

| mode | clients | rep | acked/s | worst 1s | p50 ms | p95 ms | p99 ms | max ms | errors | unacked | server CPU | PG CPU | harness ELU |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 5 | 1 | 2754.2 | 2036 | 1.5 | 3.7 | 6.1 | 64.1 | 0 | 0 | 0.76 | 0.68 | 0.14 |
| closed | 50 | 1 | 1632.5 | 1309 | 29.0 | 42.9 | 57.6 | 151.5 | 0 | 0 | 0.78 | 0.60 | 0.26 |
| open:800 | 5 | 1 | 800.0 | 795 | 2.6 | 6.1 | 24.8 | 96.5 | 0 | 0 | 0.35 | 0.24 | 0.07 |
| open:800 | 50 | 1 | 800.0 | 799 | 2.7 | 4.9 | 48.5 | 145.0 | 0 | 0 | 0.44 | 0.13 | 0.17 |
| closed | 5 | 2 | 3188.8 | 1568 | 1.4 | 2.9 | 4.7 | 72.2 | 0 | 0 | 0.78 | 0.64 | 0.14 |
| closed | 50 | 2 | 1669.5 | 1453 | 28.5 | 40.3 | 50.4 | 114.4 | 0 | 0 | 0.81 | 0.62 | 0.25 |
| open:800 | 5 | 2 | 800.0 | 798 | 2.6 | 4.5 | 8.9 | 62.0 | 0 | 0 | 0.38 | 0.21 | 0.07 |
| open:800 | 50 | 2 | 800.0 | 799 | 2.6 | 6.5 | 73.4 | 207.6 | 0 | 0 | 0.45 | 0.19 | 0.13 |
| closed | 5 | 3 | 2920.8 | 2310 | 1.5 | 3.4 | 5.2 | 91.2 | 0 | 0 | 0.78 | 0.65 | 0.14 |
| closed | 50 | 3 | 1366.8 | 951 | 32.6 | 60.6 | 102.2 | 317.4 | 0 | 0 | 0.75 | 0.59 | 0.24 |
| open:800 | 5 | 3 | 800.0 | 795 | 2.5 | 4.5 | 13.8 | 68.9 | 0 | 0 | 0.37 | 0.24 | 0.06 |
| open:800 | 50 | 3 | 800.0 | 435 | 2.9 | 117.6 | 553.0 | 704.9 | 0 | 0 | 0.44 | 0.22 | 0.14 |

Median across reps:

| mode | clients | reps | acked/s | worst 1s | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| closed | 5 | 3 | 2920.8 | 2036 | 1.5 | 3.4 | 5.2 |
| closed | 50 | 3 | 1632.5 | 1309 | 29.0 | 42.9 | 57.6 |
| open:800 | 5 | 3 | 800.0 | 795 | 2.6 | 4.5 | 13.8 |
| open:800 | 50 | 3 | 800.0 | 799 | 2.7 | 6.5 | 73.4 |

Convergence (arrival order compares all clients; inversions are seqs arriving after a higher seq):

| mode | clients | rep | same arrival order | content = DB | clients with inversions | max inversions | gaps | dups | DB contiguous | currentSeq = max | DB rows | persist failures | crashed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 5 | 1 | true | true | 0/5 | 0 | 0 | 0 | true | true | 92410 | 0 | false |
| closed | 50 | 1 | true | true | 0/50 | 0 | 0 | 0 | true | true | 56819 | 0 | false |
| open:800 | 5 | 1 | true | true | 0/5 | 0 | 0 | 0 | true | true | 28000 | 0 | false |
| open:800 | 50 | 1 | true | true | 0/50 | 0 | 0 | 0 | true | true | 28000 | 0 | false |
| closed | 5 | 2 | true | true | 0/5 | 0 | 0 | 0 | true | true | 111449 | 0 | false |
| closed | 50 | 2 | true | true | 0/50 | 0 | 0 | 0 | true | true | 57572 | 0 | false |
| open:800 | 5 | 2 | true | true | 0/5 | 0 | 0 | 0 | true | true | 28000 | 0 | false |
| open:800 | 50 | 2 | true | true | 0/50 | 0 | 0 | 0 | true | true | 28000 | 0 | false |
| closed | 5 | 3 | true | true | 0/5 | 0 | 0 | 0 | true | true | 99732 | 0 | false |
| closed | 50 | 3 | true | true | 0/50 | 0 | 0 | 0 | true | true | 47807 | 0 | false |
| open:800 | 5 | 3 | true | true | 0/5 | 0 | 0 | 0 | true | true | 28000 | 0 | false |
| open:800 | 50 | 3 | true | true | 0/50 | 0 | 0 | 0 | true | true | 28000 | 0 | false |

### Throughput: `ab-fixed`

Commit `c6d8459bef23f26c46f03d3ffa98778611528907`, Apple M1 Pro, 10 cores, 16 GB, darwin 27.0.0, Node v24.14.1. Postgres 17.10 (Homebrew): fsync=on, synchronous_commit=on, wal_sync_method=open_datasync. 30s measured after 5s warm-up, fresh server and room per run.

| mode | clients | rep | acked/s | worst 1s | p50 ms | p95 ms | p99 ms | max ms | errors | unacked | server CPU | PG CPU | harness ELU |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 5 | 1 | 2602.0 | 2278 | 1.8 | 2.5 | 3.9 | 23.1 | 0 | 0 | 0.63 | 0.36 | 0.11 |
| closed | 50 | 1 | 1363.4 | 691 | 32.5 | 60.9 | 103.6 | 399.7 | 0 | 0 | 0.68 | 0.26 | 0.24 |
| open:800 | 5 | 1 | 800.0 | 439 | 3.3 | 431.6 | 588.8 | 631.2 | 0 | 0 | 0.39 | 0.23 | 0.11 |
| open:800 | 50 | 1 | 800.0 | 646 | 2.9 | 186.8 | 461.8 | 606.2 | 0 | 0 | 0.45 | 0.18 | 0.18 |
| closed | 5 | 2 | 2213.4 | 910 | 1.9 | 3.6 | 6.4 | 100.6 | 0 | 0 | 0.60 | 0.36 | 0.10 |
| closed | 50 | 2 | 1338.9 | 506 | 33.7 | 52.4 | 79.1 | 499.7 | 0 | 0 | 0.70 | 0.27 | 0.22 |
| open:800 | 5 | 2 | 800.0 | 795 | 2.6 | 11.8 | 84.1 | 204.9 | 0 | 0 | 0.34 | 0.19 | 0.06 |
| open:800 | 50 | 2 | 800.0 | 595 | 2.8 | 214.7 | 445.8 | 485.4 | 0 | 0 | 0.47 | 0.19 | 0.15 |
| closed | 5 | 3 | 2024.7 | 1546 | 2.2 | 3.7 | 6.0 | 56.8 | 0 | 0 | 0.59 | 0.35 | 0.10 |
| closed | 50 | 3 | 1639.2 | 1262 | 28.9 | 41.3 | 53.3 | 116.5 | 0 | 0 | 0.73 | 0.26 | 0.27 |
| open:800 | 5 | 3 | 800.0 | 795 | 2.4 | 4.8 | 16.8 | 75.9 | 0 | 0 | 0.32 | 0.18 | 0.06 |
| open:800 | 50 | 3 | 800.0 | 799 | 2.6 | 4.9 | 8.3 | 25.3 | 0 | 0 | 0.42 | 0.16 | 0.13 |

Median across reps:

| mode | clients | reps | acked/s | worst 1s | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| closed | 5 | 3 | 2213.4 | 1546 | 1.9 | 3.6 | 6.0 |
| closed | 50 | 3 | 1363.4 | 691 | 32.5 | 52.4 | 79.1 |
| open:800 | 5 | 3 | 800.0 | 795 | 2.6 | 11.8 | 84.1 |
| open:800 | 50 | 3 | 800.0 | 646 | 2.8 | 186.8 | 445.8 |

Convergence (arrival order compares all clients; inversions are seqs arriving after a higher seq):

| mode | clients | rep | same arrival order | content = DB | clients with inversions | max inversions | gaps | dups | DB contiguous | currentSeq = max | DB rows | persist failures | crashed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 5 | 1 | true | true | 0/5 | 0 | 0 | 0 | true | true | 89738 | 0 | false |
| closed | 50 | 1 | true | true | 0/50 | 0 | 0 | 0 | true | true | 49050 | 0 | false |
| open:800 | 5 | 1 | true | true | 0/5 | 0 | 0 | 0 | true | true | 28000 | 0 | false |
| open:800 | 50 | 1 | true | true | 0/50 | 0 | 0 | 0 | true | true | 28000 | 0 | false |
| closed | 5 | 2 | true | true | 0/5 | 0 | 0 | 0 | true | true | 76666 | 0 | false |
| closed | 50 | 2 | true | true | 0/50 | 0 | 0 | 0 | true | true | 45093 | 0 | false |
| open:800 | 5 | 2 | true | true | 0/5 | 0 | 0 | 0 | true | true | 28000 | 0 | false |
| open:800 | 50 | 2 | true | true | 0/50 | 0 | 0 | 0 | true | true | 28000 | 0 | false |
| closed | 5 | 3 | true | true | 0/5 | 0 | 0 | 0 | true | true | 71058 | 0 | false |
| closed | 50 | 3 | true | true | 0/50 | 0 | 0 | 0 | true | true | 56797 | 0 | false |
| open:800 | 5 | 3 | true | true | 0/5 | 0 | 0 | 0 | true | true | 28000 | 0 | false |
| open:800 | 50 | 3 | true | true | 0/50 | 0 | 0 | 0 | true | true | 28000 | 0 | false |

## Raw results: Phase 3

### Throughput: `gc-main`

Commit `dc6ccfbd8b413bd4e74834491516184017445724`, Apple M1 Pro, 10 cores, 16 GB, darwin 27.0.0, Node v24.14.1. Postgres 17.10 (Homebrew): fsync=on, synchronous_commit=on, wal_sync_method=open_datasync. 60s measured after 5s warm-up, fresh server and room per run.

| mode | clients | rep | acked/s | worst 1s | p50 ms | p95 ms | p99 ms | max ms | errors | unacked | ops per commit | server CPU | PG CPU | harness ELU |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 5 | 1 | 2687.8 | 2297 | 1.8 | 2.2 | 3.7 | 17.6 | 0 | 0 | 1.00 | 0.64 | 0.36 | 0.10 |
| closed | 20 | 1 | 2245.5 | 1924 | 8.4 | 11.1 | 16.2 | 52.9 | 0 | 0 | 1.00 | 0.67 | 0.32 | 0.17 |
| closed | 50 | 1 | 1733.0 | 1456 | 27.7 | 35.6 | 47.0 | 72.5 | 0 | 0 | 1.00 | 0.73 | 0.26 | 0.30 |
| open:800 | 5 | 1 | 800.0 | 700 | 2.5 | 4.3 | 16.6 | 232.6 | 0 | 0 | 1.00 | 0.27 | 0.16 | 0.05 |
| open:800 | 20 | 1 | 800.0 | 729 | 2.8 | 6.3 | 51.7 | 130.9 | 0 | 0 | 1.00 | 0.33 | 0.17 | 0.09 |
| open:800 | 50 | 1 | 800.0 | 752 | 2.6 | 16.3 | 79.0 | 162.5 | 0 | 0 | 1.00 | 0.39 | 0.15 | 0.12 |
| closed | 5 | 2 | 2272.6 | 1663 | 2.0 | 3.1 | 4.7 | 54.0 | 0 | 0 | 1.00 | 0.63 | 0.36 | 0.11 |
| closed | 20 | 2 | 1972.1 | 1327 | 9.6 | 12.9 | 19.0 | 108.0 | 0 | 0 | 1.00 | 0.66 | 0.33 | 0.17 |
| closed | 50 | 2 | 1714.3 | 1100 | 27.8 | 35.5 | 49.3 | 118.5 | 0 | 0 | 1.00 | 0.73 | 0.27 | 0.24 |
| open:800 | 5 | 2 | 800.0 | 796 | 2.5 | 5.1 | 15.5 | 85.3 | 0 | 0 | 1.00 | 0.31 | 0.19 | 0.06 |
| open:800 | 20 | 2 | 800.0 | 799 | 2.7 | 4.8 | 10.7 | 84.7 | 0 | 0 | 1.00 | 0.33 | 0.16 | 0.07 |
| open:800 | 50 | 2 | 800.0 | 799 | 2.6 | 4.5 | 22.6 | 89.6 | 0 | 0 | 1.00 | 0.37 | 0.14 | 0.11 |
| closed | 5 | 3 | 2652.2 | 2040 | 1.8 | 2.5 | 3.7 | 29.3 | 0 | 0 | 1.00 | 0.64 | 0.36 | 0.12 |
| closed | 20 | 3 | 2213.8 | 1040 | 8.3 | 12.9 | 19.6 | 88.8 | 0 | 0 | 1.00 | 0.67 | 0.32 | 0.16 |
| closed | 50 | 3 | 1781.7 | 1322 | 26.7 | 34.5 | 51.9 | 129.3 | 0 | 0 | 1.00 | 0.73 | 0.26 | 0.25 |
| open:800 | 5 | 3 | 800.0 | 794 | 2.4 | 4.3 | 5.9 | 17.8 | 0 | 0 | 1.00 | 0.31 | 0.18 | 0.05 |
| open:800 | 20 | 3 | 800.0 | 792 | 2.5 | 4.5 | 6.6 | 23.1 | 0 | 0 | 1.00 | 0.32 | 0.16 | 0.07 |
| open:800 | 50 | 3 | 800.0 | 789 | 2.6 | 4.8 | 10.4 | 43.1 | 0 | 0 | 1.00 | 0.37 | 0.14 | 0.11 |

Median across reps:

| mode | clients | reps | acked/s | worst 1s | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| closed | 5 | 3 | 2652.2 | 2040 | 1.8 | 2.5 | 3.7 |
| closed | 20 | 3 | 2213.8 | 1327 | 8.4 | 12.9 | 19.0 |
| closed | 50 | 3 | 1733.0 | 1322 | 27.7 | 35.5 | 49.3 |
| open:800 | 5 | 3 | 800.0 | 794 | 2.5 | 4.3 | 15.5 |
| open:800 | 20 | 3 | 800.0 | 792 | 2.7 | 4.8 | 10.7 |
| open:800 | 50 | 3 | 800.0 | 789 | 2.6 | 4.8 | 22.6 |

Convergence (arrival order compares all clients; inversions are seqs arriving after a higher seq):

| mode | clients | rep | same arrival order | content = DB | clients with inversions | max inversions | gaps | dups | DB contiguous | currentSeq = max | DB rows | persist failures | crashed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 5 | 1 | true | true | 0/5 | 0 | 0 | 0 | true | true | 173502 | 0 | false |
| closed | 20 | 1 | true | true | 0/20 | 0 | 0 | 0 | true | true | 145150 | 0 | false |
| closed | 50 | 1 | true | true | 0/50 | 0 | 0 | 0 | true | true | 112210 | 0 | false |
| open:800 | 5 | 1 | true | true | 0/5 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| open:800 | 20 | 1 | true | true | 0/20 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| open:800 | 50 | 1 | true | true | 0/50 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| closed | 5 | 2 | true | true | 0/5 | 0 | 0 | 0 | true | true | 147101 | 0 | false |
| closed | 20 | 2 | true | true | 0/20 | 0 | 0 | 0 | true | true | 127478 | 0 | false |
| closed | 50 | 2 | true | true | 0/50 | 0 | 0 | 0 | true | true | 111053 | 0 | false |
| open:800 | 5 | 2 | true | true | 0/5 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| open:800 | 20 | 2 | true | true | 0/20 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| open:800 | 50 | 2 | true | true | 0/50 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| closed | 5 | 3 | true | true | 0/5 | 0 | 0 | 0 | true | true | 167651 | 0 | false |
| closed | 20 | 3 | true | true | 0/20 | 0 | 0 | 0 | true | true | 143200 | 0 | false |
| closed | 50 | 3 | true | true | 0/50 | 0 | 0 | 0 | true | true | 114885 | 0 | false |
| open:800 | 5 | 3 | true | true | 0/5 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| open:800 | 20 | 3 | true | true | 0/20 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| open:800 | 50 | 3 | true | true | 0/50 | 0 | 0 | 0 | true | true | 52000 | 0 | false |

### Throughput: `gc-new`

Commit `dc6ccfbd8b413bd4e74834491516184017445724`, Apple M1 Pro, 10 cores, 16 GB, darwin 27.0.0, Node v24.14.1. Postgres 17.10 (Homebrew): fsync=on, synchronous_commit=on, wal_sync_method=open_datasync. 60s measured after 5s warm-up, fresh server and room per run.

| mode | clients | rep | acked/s | worst 1s | p50 ms | p95 ms | p99 ms | max ms | errors | unacked | ops per commit | server CPU | PG CPU | harness ELU |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 5 | 1 | 6023.8 | 3816 | 0.7 | 1.2 | 2.1 | 58.7 | 0 | 0 | 2.50 | 0.38 | 0.48 | 0.22 |
| closed | 20 | 1 | 5706.0 | 3666 | 3.3 | 4.8 | 8.1 | 77.7 | 0 | 0 | 9.97 | 0.61 | 0.24 | 0.40 |
| closed | 50 | 1 | 3260.6 | 1603 | 14.6 | 19.5 | 38.1 | 179.1 | 0 | 0 | 24.65 | 0.86 | 0.11 | 0.57 |
| open:800 | 5 | 1 | 800.0 | 710 | 2.1 | 5.2 | 16.7 | 221.3 | 0 | 0 | 1.17 | 0.15 | 0.20 | 0.09 |
| open:800 | 20 | 1 | 800.0 | 786 | 2.1 | 4.0 | 9.0 | 62.0 | 0 | 0 | 1.32 | 0.17 | 0.16 | 0.09 |
| open:800 | 50 | 1 | 800.0 | 796 | 2.5 | 4.6 | 7.9 | 79.4 | 0 | 0 | 1.21 | 0.28 | 0.18 | 0.14 |
| closed | 5 | 2 | 7074.1 | 5927 | 0.7 | 0.9 | 1.1 | 12.8 | 0 | 0 | 2.50 | 0.40 | 0.48 | 0.24 |
| closed | 20 | 2 | 5451.6 | 4254 | 3.9 | 4.3 | 6.2 | 24.5 | 0 | 0 | 9.98 | 0.51 | 0.18 | 0.38 |
| closed | 50 | 2 | 3715.8 | 3113 | 13.6 | 15.2 | 17.6 | 48.1 | 0 | 0 | 24.73 | 0.91 | 0.10 | 0.54 |
| open:800 | 5 | 2 | 800.0 | 796 | 2.5 | 4.9 | 7.5 | 23.6 | 0 | 0 | 1.14 | 0.22 | 0.29 | 0.09 |
| open:800 | 20 | 2 | 800.0 | 792 | 2.8 | 4.7 | 7.0 | 26.9 | 0 | 0 | 1.26 | 0.26 | 0.24 | 0.11 |
| open:800 | 50 | 2 | 800.0 | 780 | 2.6 | 4.9 | 12.5 | 72.8 | 0 | 0 | 1.13 | 0.30 | 0.18 | 0.20 |
| closed | 5 | 3 | 6900.8 | 5761 | 0.7 | 0.9 | 1.2 | 28.4 | 0 | 0 | 2.50 | 0.39 | 0.47 | 0.24 |
| closed | 20 | 3 | 6007.3 | 4279 | 3.2 | 4.3 | 6.1 | 36.1 | 0 | 0 | 9.98 | 0.59 | 0.21 | 0.38 |
| closed | 50 | 3 | 3831.3 | 3348 | 13.2 | 14.8 | 16.8 | 61.1 | 0 | 0 | 24.69 | 0.91 | 0.10 | 0.51 |
| open:800 | 5 | 3 | 800.0 | 683 | 2.4 | 5.2 | 9.0 | 250.1 | 0 | 0 | 1.14 | 0.22 | 0.29 | 0.09 |
| open:800 | 20 | 3 | 800.0 | 774 | 2.7 | 4.5 | 6.7 | 37.3 | 0 | 0 | 1.16 | 0.27 | 0.24 | 0.13 |
| open:800 | 50 | 3 | 800.0 | 798 | 2.7 | 4.4 | 6.0 | 19.7 | 0 | 0 | 1.12 | 0.29 | 0.17 | 0.21 |

Median across reps:

| mode | clients | reps | acked/s | worst 1s | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| closed | 5 | 3 | 6900.8 | 5761 | 0.7 | 0.9 | 1.2 |
| closed | 20 | 3 | 5706.0 | 4254 | 3.3 | 4.3 | 6.2 |
| closed | 50 | 3 | 3715.8 | 3113 | 13.6 | 15.2 | 17.6 |
| open:800 | 5 | 3 | 800.0 | 710 | 2.4 | 5.2 | 9.0 |
| open:800 | 20 | 3 | 800.0 | 786 | 2.7 | 4.5 | 7.0 |
| open:800 | 50 | 3 | 800.0 | 796 | 2.6 | 4.6 | 7.9 |

Convergence (arrival order compares all clients; inversions are seqs arriving after a higher seq):

| mode | clients | rep | same arrival order | content = DB | clients with inversions | max inversions | gaps | dups | DB contiguous | currentSeq = max | DB rows | persist failures | crashed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 5 | 1 | true | true | 0/5 | 0 | 0 | 0 | true | true | 392005 | 0 | false |
| closed | 20 | 1 | true | true | 0/20 | 0 | 0 | 0 | true | true | 367920 | 0 | false |
| closed | 50 | 1 | true | true | 0/50 | 0 | 0 | 0 | true | true | 213434 | 0 | false |
| open:800 | 5 | 1 | true | true | 0/5 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| open:800 | 20 | 1 | true | true | 0/20 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| open:800 | 50 | 1 | true | true | 0/50 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| closed | 5 | 2 | true | true | 0/5 | 0 | 0 | 0 | true | true | 459635 | 0 | false |
| closed | 20 | 2 | true | true | 0/20 | 0 | 0 | 0 | true | true | 351854 | 0 | false |
| closed | 50 | 2 | true | true | 0/50 | 0 | 0 | 0 | true | true | 241645 | 0 | false |
| open:800 | 5 | 2 | true | true | 0/5 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| open:800 | 20 | 2 | true | true | 0/20 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| open:800 | 50 | 2 | true | true | 0/50 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| closed | 5 | 3 | true | true | 0/5 | 0 | 0 | 0 | true | true | 447074 | 0 | false |
| closed | 20 | 3 | true | true | 0/20 | 0 | 0 | 0 | true | true | 385734 | 0 | false |
| closed | 50 | 3 | true | true | 0/50 | 0 | 0 | 0 | true | true | 248323 | 0 | false |
| open:800 | 5 | 3 | true | true | 0/5 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| open:800 | 20 | 3 | true | true | 0/20 | 0 | 0 | 0 | true | true | 52000 | 0 | false |
| open:800 | 50 | 3 | true | true | 0/50 | 0 | 0 | 0 | true | true | 52000 | 0 | false |

### Throughput: `gc-main-delay5`

Commit `dc6ccfbd8b413bd4e74834491516184017445724`, Apple M1 Pro, 10 cores, 16 GB, darwin 27.0.0, Node v24.14.1. Postgres 17.10 (Homebrew): fsync=on, synchronous_commit=on, wal_sync_method=open_datasync. 30s measured after 5s warm-up, fresh server and room per run.

| mode | clients | rep | acked/s | worst 1s | p50 ms | p95 ms | p99 ms | max ms | errors | unacked | ops per commit | server CPU | PG CPU | harness ELU |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 5 | 1 | 31.0 | 22 | 161.9 | 181.3 | 197.0 | 412.1 | 0 | 0 | 0.99 | 0.13 | 0.05 | 0.03 |
| closed | 20 | 1 | 29.6 | 8 | 681.0 | 726.2 | 745.3 | 773.4 | 0 | 0 | 0.96 | 0.14 | 0.05 | 0.06 |
| closed | 50 | 1 | 28.0 | 0 | 1787.9 | 1893.8 | 1917.2 | 1928.9 | 0 | 0 | 0.94 | 0.17 | 0.05 | 0.10 |
| open:800 | 5 | 1 | 27.2 | 0 | 2029.1 | 2042.6 | 2051.6 | 2069.1 | 26983 | 26983 | 0.98 | 0.34 | 0.02 | 0.07 |
| open:800 | 20 | 1 | 27.6 | 0 | 2029.3 | 2040.9 | 2048.9 | 2071.5 | 26974 | 26974 | 0.96 | 0.34 | 0.03 | 0.07 |
| open:800 | 50 | 1 | 27.7 | 0 | 2029.6 | 2042.3 | 2051.7 | 2081.7 | 26968 | 26968 | 0.93 | 0.33 | 0.02 | 0.07 |
| closed | 5 | 2 | 30.2 | 24 | 168.3 | 184.8 | 196.6 | 217.6 | 0 | 0 | 0.99 | 0.14 | 0.06 | 0.03 |
| closed | 20 | 2 | 30.2 | 10 | 667.5 | 735.2 | 758.1 | 766.1 | 0 | 0 | 0.97 | 0.15 | 0.05 | 0.06 |
| closed | 50 | 2 | 29.6 | 0 | 1670.3 | 1882.6 | 1932.8 | 1944.3 | 0 | 0 | 0.94 | 0.15 | 0.05 | 0.08 |
| open:800 | 5 | 2 | 27.8 | 0 | 2029.4 | 2039.2 | 2047.2 | 2081.8 | 26955 | 26955 | 0.98 | 0.32 | 0.03 | 0.06 |
| open:800 | 20 | 2 | 27.0 | 0 | 2029.1 | 2042.0 | 2048.8 | 2070.4 | 26992 | 26992 | 0.96 | 0.34 | 0.03 | 0.06 |
| open:800 | 50 | 2 | 27.3 | 0 | 2029.8 | 2041.0 | 2050.8 | 2177.9 | 26980 | 26980 | 0.93 | 0.34 | 0.02 | 0.07 |
| closed | 5 | 3 | 30.1 | 24 | 167.1 | 186.0 | 197.4 | 220.6 | 0 | 0 | 0.98 | 0.15 | 0.06 | 0.03 |
| closed | 20 | 3 | 30.3 | 8 | 664.5 | 709.6 | 783.7 | 810.2 | 0 | 0 | 0.97 | 0.14 | 0.05 | 0.06 |
| closed | 50 | 3 | 28.8 | 0 | 1736.2 | 1846.9 | 1875.0 | 1896.1 | 0 | 0 | 0.94 | 0.16 | 0.05 | 0.09 |
| open:800 | 5 | 3 | 27.5 | 0 | 2029.1 | 2040.6 | 2048.3 | 2063.6 | 26975 | 26975 | 0.98 | 0.35 | 0.02 | 0.06 |
| open:800 | 20 | 3 | 27.5 | 0 | 2029.3 | 2039.9 | 2047.1 | 2069.0 | 26983 | 26983 | 0.96 | 0.35 | 0.02 | 0.07 |
| open:800 | 50 | 3 | 27.5 | 0 | 2029.7 | 2040.1 | 2046.0 | 2076.1 | 26980 | 26980 | 0.93 | 0.35 | 0.02 | 0.08 |

Median across reps:

| mode | clients | reps | acked/s | worst 1s | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| closed | 5 | 3 | 30.2 | 24 | 167.1 | 184.8 | 197.0 |
| closed | 20 | 3 | 30.2 | 8 | 667.5 | 726.2 | 758.1 |
| closed | 50 | 3 | 28.8 | 0 | 1736.2 | 1882.6 | 1917.2 |
| open:800 | 5 | 3 | 27.5 | 0 | 2029.1 | 2040.6 | 2048.3 |
| open:800 | 20 | 3 | 27.5 | 0 | 2029.3 | 2040.9 | 2048.8 |
| open:800 | 50 | 3 | 27.5 | 0 | 2029.7 | 2041.0 | 2050.8 |

Convergence (arrival order compares all clients; inversions are seqs arriving after a higher seq):

| mode | clients | rep | same arrival order | content = DB | clients with inversions | max inversions | gaps | dups | DB contiguous | currentSeq = max | DB rows | persist failures | crashed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 5 | 1 | true | true | 0/5 | 0 | 0 | 0 | true | true | 1083 | 0 | false |
| closed | 20 | 1 | true | true | 0/20 | 0 | 0 | 0 | true | true | 1046 | 0 | false |
| closed | 50 | 1 | true | true | 0/50 | 0 | 0 | 0 | true | true | 1031 | 0 | false |
| open:800 | 5 | 1 | true | true | 0/5 | 0 | 0 | 0 | true | true | 1017 | 26983 | false |
| open:800 | 20 | 1 | true | true | 0/20 | 0 | 0 | 0 | true | true | 1026 | 26974 | false |
| open:800 | 50 | 1 | true | true | 0/50 | 0 | 0 | 0 | true | true | 1032 | 26968 | false |
| closed | 5 | 2 | true | true | 0/5 | 0 | 0 | 0 | true | true | 1058 | 0 | false |
| closed | 20 | 2 | true | true | 0/20 | 0 | 0 | 0 | true | true | 1065 | 0 | false |
| closed | 50 | 2 | true | true | 0/50 | 0 | 0 | 0 | true | true | 1075 | 0 | false |
| open:800 | 5 | 2 | true | true | 0/5 | 0 | 0 | 0 | true | true | 1045 | 26955 | false |
| open:800 | 20 | 2 | true | true | 0/20 | 0 | 0 | 0 | true | true | 1008 | 26992 | false |
| open:800 | 50 | 2 | true | true | 0/50 | 0 | 0 | 0 | true | true | 1020 | 26980 | false |
| closed | 5 | 3 | true | true | 0/5 | 0 | 0 | 0 | true | true | 1058 | 0 | false |
| closed | 20 | 3 | true | true | 0/20 | 0 | 0 | 0 | true | true | 1079 | 0 | false |
| closed | 50 | 3 | true | true | 0/50 | 0 | 0 | 0 | true | true | 1049 | 0 | false |
| open:800 | 5 | 3 | true | true | 0/5 | 0 | 0 | 0 | true | true | 1025 | 26975 | false |
| open:800 | 20 | 3 | true | true | 0/20 | 0 | 0 | 0 | true | true | 1017 | 26983 | false |
| open:800 | 50 | 3 | true | true | 0/50 | 0 | 0 | 0 | true | true | 1020 | 26980 | false |

### Throughput: `gc-new-delay5`

Commit `dc6ccfbd8b413bd4e74834491516184017445724`, Apple M1 Pro, 10 cores, 16 GB, darwin 27.0.0, Node v24.14.1. Postgres 17.10 (Homebrew): fsync=on, synchronous_commit=on, wal_sync_method=open_datasync. 30s measured after 5s warm-up, fresh server and room per run.

| mode | clients | rep | acked/s | worst 1s | p50 ms | p95 ms | p99 ms | max ms | errors | unacked | ops per commit | server CPU | PG CPU | harness ELU |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 5 | 1 | 259.7 | 230 | 19.6 | 24.9 | 30.2 | 37.8 | 0 | 0 | 2.49 | 0.14 | 0.14 | 0.10 |
| closed | 20 | 1 | 888.0 | 801 | 22.6 | 27.1 | 30.3 | 50.0 | 0 | 0 | 9.87 | 0.26 | 0.09 | 0.18 |
| closed | 50 | 1 | 1913.3 | 1816 | 26.2 | 27.3 | 31.6 | 51.3 | 0 | 0 | 24.35 | 0.48 | 0.05 | 0.30 |
| open:800 | 5 | 1 | 800.0 | 788 | 16.4 | 24.2 | 28.7 | 51.3 | 0 | 0 | 7.46 | 0.19 | 0.16 | 0.18 |
| open:800 | 20 | 1 | 800.0 | 784 | 19.9 | 27.1 | 30.6 | 55.5 | 0 | 0 | 8.44 | 0.26 | 0.10 | 0.19 |
| open:800 | 50 | 1 | 800.0 | 785 | 24.2 | 31.8 | 35.6 | 52.0 | 0 | 0 | 10.05 | 0.34 | 0.06 | 0.21 |
| closed | 5 | 2 | 256.4 | 231 | 20.0 | 23.9 | 29.6 | 61.4 | 0 | 0 | 2.48 | 0.15 | 0.15 | 0.10 |
| closed | 20 | 2 | 893.9 | 835 | 22.5 | 27.3 | 30.0 | 37.0 | 0 | 0 | 9.89 | 0.26 | 0.09 | 0.18 |
| closed | 50 | 2 | 1906.2 | 1806 | 26.4 | 27.4 | 28.6 | 44.4 | 0 | 0 | 24.32 | 0.48 | 0.05 | 0.30 |
| open:800 | 5 | 2 | 800.0 | 790 | 16.9 | 24.4 | 28.0 | 44.6 | 0 | 0 | 7.58 | 0.20 | 0.17 | 0.15 |
| open:800 | 20 | 2 | 800.0 | 793 | 19.4 | 28.3 | 220.5 | 432.6 | 0 | 0 | 8.35 | 0.25 | 0.10 | 0.19 |
| open:800 | 50 | 2 | 800.0 | 785 | 23.5 | 31.1 | 35.5 | 54.5 | 0 | 0 | 9.82 | 0.33 | 0.07 | 0.21 |
| closed | 5 | 3 | 252.3 | 221 | 19.9 | 25.1 | 30.6 | 49.0 | 0 | 0 | 2.48 | 0.15 | 0.15 | 0.11 |
| closed | 20 | 3 | 1162.7 | 1040 | 17.0 | 18.3 | 20.0 | 48.2 | 0 | 0 | 9.91 | 0.16 | 0.06 | 0.12 |
| closed | 50 | 3 | 1840.9 | 1369 | 26.0 | 35.9 | 50.9 | 137.9 | 0 | 0 | 24.32 | 0.50 | 0.06 | 0.30 |
| open:800 | 5 | 3 | 800.0 | 785 | 16.4 | 25.5 | 35.8 | 93.3 | 0 | 0 | 7.38 | 0.19 | 0.14 | 0.20 |
| open:800 | 20 | 3 | 800.0 | 785 | 18.7 | 25.7 | 29.8 | 55.6 | 0 | 0 | 7.93 | 0.25 | 0.10 | 0.20 |
| open:800 | 50 | 3 | 800.0 | 785 | 20.7 | 28.7 | 45.9 | 102.9 | 0 | 0 | 8.79 | 0.30 | 0.06 | 0.20 |

Median across reps:

| mode | clients | reps | acked/s | worst 1s | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| closed | 5 | 3 | 256.4 | 230 | 19.9 | 24.9 | 30.2 |
| closed | 20 | 3 | 893.9 | 835 | 22.5 | 27.1 | 30.0 |
| closed | 50 | 3 | 1906.2 | 1806 | 26.2 | 27.4 | 31.6 |
| open:800 | 5 | 3 | 800.0 | 788 | 16.4 | 24.4 | 28.7 |
| open:800 | 20 | 3 | 800.0 | 785 | 19.4 | 27.1 | 30.6 |
| open:800 | 50 | 3 | 800.0 | 785 | 23.5 | 31.1 | 35.6 |

Convergence (arrival order compares all clients; inversions are seqs arriving after a higher seq):

| mode | clients | rep | same arrival order | content = DB | clients with inversions | max inversions | gaps | dups | DB contiguous | currentSeq = max | DB rows | persist failures | crashed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 5 | 1 | true | true | 0/5 | 0 | 0 | 0 | true | true | 9011 | 0 | false |
| closed | 20 | 1 | true | true | 0/20 | 0 | 0 | 0 | true | true | 31060 | 0 | false |
| closed | 50 | 1 | true | true | 0/50 | 0 | 0 | 0 | true | true | 67000 | 0 | false |
| open:800 | 5 | 1 | true | true | 0/5 | 0 | 0 | 0 | true | true | 28000 | 0 | false |
| open:800 | 20 | 1 | true | true | 0/20 | 0 | 0 | 0 | true | true | 28000 | 0 | false |
| open:800 | 50 | 1 | true | true | 0/50 | 0 | 0 | 0 | true | true | 28000 | 0 | false |
| closed | 5 | 2 | true | true | 0/5 | 0 | 0 | 0 | true | true | 9011 | 0 | false |
| closed | 20 | 2 | true | true | 0/20 | 0 | 0 | 0 | true | true | 31156 | 0 | false |
| closed | 50 | 2 | true | true | 0/50 | 0 | 0 | 0 | true | true | 66632 | 0 | false |
| open:800 | 5 | 2 | true | true | 0/5 | 0 | 0 | 0 | true | true | 28000 | 0 | false |
| open:800 | 20 | 2 | true | true | 0/20 | 0 | 0 | 0 | true | true | 28000 | 0 | false |
| open:800 | 50 | 2 | true | true | 0/50 | 0 | 0 | 0 | true | true | 28000 | 0 | false |
| closed | 5 | 3 | true | true | 0/5 | 0 | 0 | 0 | true | true | 8800 | 0 | false |
| closed | 20 | 3 | true | true | 0/20 | 0 | 0 | 0 | true | true | 39821 | 0 | false |
| closed | 50 | 3 | true | true | 0/50 | 0 | 0 | 0 | true | true | 65079 | 0 | false |
| open:800 | 5 | 3 | true | true | 0/5 | 0 | 0 | 0 | true | true | 28000 | 0 | false |
| open:800 | 20 | 3 | true | true | 0/20 | 0 | 0 | 0 | true | true | 28000 | 0 | false |
| open:800 | 50 | 3 | true | true | 0/50 | 0 | 0 | 0 | true | true | 28000 | 0 | false |

### Throughput: `gc-main-fullfsync`

Commit `dc6ccfbd8b413bd4e74834491516184017445724`, Apple M1 Pro, 10 cores, 16 GB, darwin 27.0.0, Node v24.14.1. Postgres 17.10 (Homebrew): fsync=on, synchronous_commit=on, wal_sync_method=fsync_writethrough. 30s measured after 5s warm-up, fresh server and room per run.

| mode | clients | rep | acked/s | worst 1s | p50 ms | p95 ms | p99 ms | max ms | errors | unacked | ops per commit | server CPU | PG CPU | harness ELU |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 20 | 1 | 134.5 | 115 | 151.9 | 185.5 | 203.0 | 225.1 | 0 | 0 | 0.99 | 0.26 | 0.13 | 0.11 |
| open:800 | 20 | 1 | 144.0 | 0 | 2006.4 | 2011.1 | 2015.3 | 2023.8 | 22650 | 22650 | 0.99 | 0.39 | 0.08 | 0.08 |
| closed | 20 | 2 | 129.8 | 110 | 158.8 | 190.1 | 206.2 | 244.2 | 0 | 0 | 0.99 | 0.25 | 0.12 | 0.12 |
| open:800 | 20 | 2 | 130.7 | 0 | 2007.1 | 2012.7 | 2021.8 | 2105.1 | 23151 | 23151 | 0.99 | 0.37 | 0.08 | 0.09 |
| closed | 20 | 3 | 134.6 | 111 | 153.1 | 183.2 | 194.1 | 244.4 | 0 | 0 | 0.99 | 0.25 | 0.12 | 0.12 |
| open:800 | 20 | 3 | 133.2 | 0 | 2007.3 | 2013.8 | 2635.9 | 3185.4 | 23039 | 23039 | 0.99 | 0.36 | 0.08 | 0.10 |

Median across reps:

| mode | clients | reps | acked/s | worst 1s | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| closed | 20 | 3 | 134.5 | 111 | 153.1 | 185.5 | 203.0 |
| open:800 | 20 | 3 | 133.2 | 0 | 2007.1 | 2012.7 | 2021.8 |

Convergence (arrival order compares all clients; inversions are seqs arriving after a higher seq):

| mode | clients | rep | same arrival order | content = DB | clients with inversions | max inversions | gaps | dups | DB contiguous | currentSeq = max | DB rows | persist failures | crashed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 20 | 1 | true | true | 0/20 | 0 | 0 | 0 | true | true | 4656 | 0 | false |
| open:800 | 20 | 1 | true | true | 0/20 | 0 | 0 | 0 | true | true | 5350 | 22650 | false |
| closed | 20 | 2 | true | true | 0/20 | 0 | 0 | 0 | true | true | 4509 | 0 | false |
| open:800 | 20 | 2 | true | true | 0/20 | 0 | 0 | 0 | true | true | 4849 | 23151 | false |
| closed | 20 | 3 | true | true | 0/20 | 0 | 0 | 0 | true | true | 4665 | 0 | false |
| open:800 | 20 | 3 | true | true | 0/20 | 0 | 0 | 0 | true | true | 4961 | 23039 | false |

### Throughput: `gc-new-fullfsync`

Commit `dc6ccfbd8b413bd4e74834491516184017445724`, Apple M1 Pro, 10 cores, 16 GB, darwin 27.0.0, Node v24.14.1. Postgres 17.10 (Homebrew): fsync=on, synchronous_commit=on, wal_sync_method=fsync_writethrough. 30s measured after 5s warm-up, fresh server and room per run.

| mode | clients | rep | acked/s | worst 1s | p50 ms | p95 ms | p99 ms | max ms | errors | unacked | ops per commit | server CPU | PG CPU | harness ELU |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 20 | 1 | 1348.7 | 1061 | 14.0 | 21.3 | 26.9 | 104.0 | 0 | 0 | 9.91 | 0.28 | 0.11 | 0.22 |
| open:800 | 20 | 1 | 800.0 | 617 | 13.6 | 22.0 | 219.7 | 463.5 | 0 | 0 | 5.80 | 0.25 | 0.12 | 0.17 |
| closed | 20 | 2 | 1362.2 | 1266 | 14.7 | 18.4 | 21.9 | 36.7 | 0 | 0 | 9.91 | 0.30 | 0.11 | 0.17 |
| open:800 | 20 | 2 | 800.0 | 788 | 13.7 | 20.0 | 24.4 | 71.6 | 0 | 0 | 5.65 | 0.26 | 0.13 | 0.20 |
| closed | 20 | 3 | 1288.1 | 1179 | 15.3 | 20.8 | 24.8 | 32.4 | 0 | 0 | 9.92 | 0.30 | 0.11 | 0.23 |
| open:800 | 20 | 3 | 800.0 | 788 | 13.0 | 20.3 | 26.4 | 49.6 | 0 | 0 | 5.29 | 0.24 | 0.12 | 0.23 |

Median across reps:

| mode | clients | reps | acked/s | worst 1s | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| closed | 20 | 3 | 1348.7 | 1179 | 14.7 | 20.8 | 24.8 |
| open:800 | 20 | 3 | 800.0 | 788 | 13.6 | 20.3 | 26.4 |

Convergence (arrival order compares all clients; inversions are seqs arriving after a higher seq):

| mode | clients | rep | same arrival order | content = DB | clients with inversions | max inversions | gaps | dups | DB contiguous | currentSeq = max | DB rows | persist failures | crashed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 20 | 1 | true | true | 0/20 | 0 | 0 | 0 | true | true | 47102 | 0 | false |
| open:800 | 20 | 1 | true | true | 0/20 | 0 | 0 | 0 | true | true | 28000 | 0 | false |
| closed | 20 | 2 | true | true | 0/20 | 0 | 0 | 0 | true | true | 47918 | 0 | false |
| open:800 | 20 | 2 | true | true | 0/20 | 0 | 0 | 0 | true | true | 28000 | 0 | false |
| closed | 20 | 3 | true | true | 0/20 | 0 | 0 | 0 | true | true | 45060 | 0 | false |
| open:800 | 20 | 3 | true | true | 0/20 | 0 | 0 | 0 | true | true | 27999 | 0 | false |

### Throughput: `phase2-final`

Commit `edd57411bf10e69cbe8064fd0ad67670c54bee3c`, Apple M1 Pro, 10 cores, 16 GB, darwin 27.0.0, Node v24.14.1. Postgres 17.10 (Homebrew): fsync=on, synchronous_commit=on, wal_sync_method=open_datasync. 30s measured after 5s warm-up, fresh server and room per run.

| mode | clients | rep | acked/s | worst 1s | p50 ms | p95 ms | p99 ms | max ms | errors | unacked | ops per commit | server CPU | PG CPU | harness ELU |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 5 | 1 | 262.2 | 236 | 19.3 | 24.4 | 28.8 | 55.3 | 0 | 0 | 2.48 | 0.16 | 0.16 | 0.12 |
| closed | 20 | 1 | 967.9 | 899 | 20.8 | 25.1 | 28.9 | 34.0 | 0 | 0 | 9.84 | 0.24 | 0.09 | 0.17 |
| closed | 50 | 1 | 1887.8 | 1347 | 25.9 | 30.1 | 40.8 | 181.3 | 0 | 0 | 23.90 | 0.50 | 0.06 | 0.31 |
| open:800 | 5 | 1 | 800.0 | 788 | 16.4 | 24.3 | 29.3 | 46.7 | 0 | 0 | 7.30 | 0.19 | 0.16 | 0.18 |
| open:800 | 20 | 1 | 800.0 | 788 | 18.8 | 25.6 | 28.7 | 48.4 | 0 | 0 | 7.97 | 0.25 | 0.11 | 0.20 |
| open:800 | 50 | 1 | 800.0 | 786 | 21.5 | 27.5 | 32.2 | 60.3 | 0 | 0 | 8.93 | 0.30 | 0.07 | 0.22 |

Median across reps:

| mode | clients | reps | acked/s | worst 1s | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| closed | 5 | 1 | 262.2 | 236 | 19.3 | 24.4 | 28.8 |
| closed | 20 | 1 | 967.9 | 899 | 20.8 | 25.1 | 28.9 |
| closed | 50 | 1 | 1887.8 | 1347 | 25.9 | 30.1 | 40.8 |
| open:800 | 5 | 1 | 800.0 | 788 | 16.4 | 24.3 | 29.3 |
| open:800 | 20 | 1 | 800.0 | 788 | 18.8 | 25.6 | 28.7 |
| open:800 | 50 | 1 | 800.0 | 786 | 21.5 | 27.5 | 32.2 |

Convergence (arrival order compares all clients; inversions are seqs arriving after a higher seq):

| mode | clients | rep | same arrival order | content = DB | clients with inversions | max inversions | gaps | dups | DB contiguous | currentSeq = max | DB rows | persist failures | crashed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 5 | 1 | true | true | 0/5 | 0 | 0 | 0 | true | true | 9125 | 0 | false |
| closed | 20 | 1 | true | true | 0/20 | 0 | 0 | 0 | true | true | 33819 | 0 | false |
| closed | 50 | 1 | true | true | 0/50 | 0 | 0 | 0 | true | true | 66400 | 0 | false |
| open:800 | 5 | 1 | true | true | 0/5 | 0 | 0 | 0 | true | true | 28000 | 0 | false |
| open:800 | 20 | 1 | true | true | 0/20 | 0 | 0 | 0 | true | true | 28000 | 0 | false |
| open:800 | 50 | 1 | true | true | 0/50 | 0 | 0 | 0 | true | true | 28000 | 0 | false |

### Throughput: `phase2-final-nodelay`

Commit `edd57411bf10e69cbe8064fd0ad67670c54bee3c`, Apple M1 Pro, 10 cores, 16 GB, darwin 27.0.0, Node v24.14.1. Postgres 17.10 (Homebrew): fsync=on, synchronous_commit=on, wal_sync_method=open_datasync. 30s measured after 5s warm-up, fresh server and room per run.

| mode | clients | rep | acked/s | worst 1s | p50 ms | p95 ms | p99 ms | max ms | errors | unacked | ops per commit | server CPU | PG CPU | harness ELU |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 5 | 1 | 6433.5 | 4542 | 0.7 | 1.0 | 1.6 | 18.3 | 0 | 0 | 2.50 | 0.38 | 0.48 | 0.23 |
| closed | 20 | 1 | 5806.8 | 4737 | 3.7 | 4.3 | 5.8 | 18.7 | 0 | 0 | 9.96 | 0.56 | 0.20 | 0.38 |
| closed | 50 | 1 | 3815.7 | 3585 | 13.2 | 15.0 | 16.9 | 35.1 | 0 | 0 | 24.42 | 0.92 | 0.10 | 0.51 |
| open:800 | 5 | 1 | 800.0 | 795 | 2.3 | 4.5 | 7.0 | 17.2 | 0 | 0 | 1.11 | 0.23 | 0.29 | 0.09 |
| open:800 | 20 | 1 | 800.0 | 799 | 2.6 | 4.3 | 6.5 | 16.2 | 0 | 0 | 1.18 | 0.30 | 0.25 | 0.13 |
| open:800 | 50 | 1 | 800.0 | 799 | 2.5 | 4.2 | 8.1 | 34.1 | 0 | 0 | 1.11 | 0.31 | 0.18 | 0.16 |

Median across reps:

| mode | clients | reps | acked/s | worst 1s | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|---|---|
| closed | 5 | 1 | 6433.5 | 4542 | 0.7 | 1.0 | 1.6 |
| closed | 20 | 1 | 5806.8 | 4737 | 3.7 | 4.3 | 5.8 |
| closed | 50 | 1 | 3815.7 | 3585 | 13.2 | 15.0 | 16.9 |
| open:800 | 5 | 1 | 800.0 | 795 | 2.3 | 4.5 | 7.0 |
| open:800 | 20 | 1 | 800.0 | 799 | 2.6 | 4.3 | 6.5 |
| open:800 | 50 | 1 | 800.0 | 799 | 2.5 | 4.2 | 8.1 |

Convergence (arrival order compares all clients; inversions are seqs arriving after a higher seq):

| mode | clients | rep | same arrival order | content = DB | clients with inversions | max inversions | gaps | dups | DB contiguous | currentSeq = max | DB rows | persist failures | crashed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| closed | 5 | 1 | true | true | 0/5 | 0 | 0 | 0 | true | true | 224481 | 0 | false |
| closed | 20 | 1 | true | true | 0/20 | 0 | 0 | 0 | true | true | 204702 | 0 | false |
| closed | 50 | 1 | true | true | 0/50 | 0 | 0 | 0 | true | true | 133234 | 0 | false |
| open:800 | 5 | 1 | true | true | 0/5 | 0 | 0 | 0 | true | true | 28000 | 0 | false |
| open:800 | 20 | 1 | true | true | 0/20 | 0 | 0 | 0 | true | true | 28000 | 0 | false |
| open:800 | 50 | 1 | true | true | 0/50 | 0 | 0 | 0 | true | true | 28000 | 0 | false |
