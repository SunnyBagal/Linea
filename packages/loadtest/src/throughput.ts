// Throughput and convergence runs against one room.
//
//   closed    each client sends its next op when the previous ack arrives: finds capacity
//   open:N    N ops/s in total on a fixed schedule, latency measured from the intended
//             send time: tests whether a target rate is actually sustained
//
// Usage: tsx src/throughput.ts --label before --clients 5,20,50 --modes closed,open:800 --reps 3
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  auditRoom, db, environmentInfo, percentile, postgresCpuSeconds, postgresSettings, resultsDir,
  seedRoom, seedUser, sleep, startBackend, startDbProxy, tokenFor,
} from './lib.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1]! : fallback;
}

const label = arg('label', 'adhoc');
const clientCounts = arg('clients', '5,20,50').split(',').map(Number);
const modes = arg('modes', 'closed,open:800').split(',');
const reps = Number(arg('reps', '3'));
const durationMs = Number(arg('duration', '60')) * 1000;
const warmupMs = Number(arg('warmup', '5')) * 1000;
const settleMs = Number(arg('settle', '20')) * 1000;
const workerCount = Number(arg('workers', '4'));
// Delays each database reply through a local proxy, to see how a fix behaves with network latency.
const dbDelayMs = Number(arg('db-delay', '0'));
const WS_PORT = 18090;

const outDir = resultsDir(label);
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'throughput.jsonl');

interface WorkerResult {
  latencies: number[];
  ackBuckets: Array<[number, number]>;
  clients: any[];
  elu: number;
}

async function runCell(mode: string, clients: number, rep: number) {
  const pool = db();
  await pool.query('TRUNCATE "Operation"');
  await pool.query('VACUUM ANALYZE "Room"');
  await pool.query('VACUUM ANALYZE "Operation"');
  const userId = await seedUser(pool);
  const roomId = await seedRoom(pool, userId);
  const tokens = Array.from({ length: clients }, () => tokenFor(userId));
  const proxy = dbDelayMs > 0 ? await startDbProxy(() => dbDelayMs) : null;
  const backend = await startBackend('ws', WS_PORT, `throughput-${mode.replace(':', '')}-c${clients}-r${rep}`,
    proxy ? { databaseUrl: proxy.url } : {});

  const [modeName, rateText] = mode.split(':');
  const totalRate = Number(rateText ?? 0);
  const runId = `${Date.now().toString(36)}`;

  const workers: Worker[] = [];
  const ready: Array<Promise<void>> = [];
  const results: Array<Promise<WorkerResult>> = [];
  const share = Math.ceil(clients / workerCount);
  for (let w = 0, offset = 0; offset < clients; w += 1, offset += share) {
    const worker = new Worker(new URL('./throughput-worker.ts', import.meta.url), {
      workerData: {
        url: backend.url,
        roomId,
        tokens: tokens.slice(offset, offset + share),
        clientOffset: offset,
        mode: modeName,
        ratePerClient: totalRate / clients,
        runId,
      },
    });
    workers.push(worker);
    ready.push(new Promise((resolve, reject) => {
      worker.on('message', (m) => { if (m.type === 'ready') resolve(); else if (m.type === 'fatal') reject(new Error(m.error)); });
      worker.once('error', reject);
    }));
    results.push(new Promise((resolve, reject) => {
      worker.on('message', (m) => { if (m.type === 'result') resolve(m); else if (m.type === 'fatal') reject(new Error(m.error)); });
    }));
  }
  await Promise.all(ready);
  // join_room has no ack frame, so give every join time to land before sending.
  await sleep(1000);

  const cpuPgStart = { at: 0, value: null as number | null };
  const measuredStart = Date.now() + warmupMs;
  for (const worker of workers) worker.postMessage({ type: 'start', warmupMs, durationMs, settleMs });
  await sleep(warmupMs);
  cpuPgStart.at = Date.now();
  cpuPgStart.value = postgresCpuSeconds();
  await sleep(durationMs);
  const cpuPgEnd = postgresCpuSeconds();
  const pgWallSeconds = (Date.now() - cpuPgStart.at) / 1000;

  const parts = await Promise.all(results);
  await Promise.all(workers.map((worker) => worker.terminate()));
  const audit = await auditRoom(pool, roomId);

  const latencies = Float64Array.from(parts.flatMap((part) => part.latencies)).sort();
  const perClient = parts.flatMap((part) => part.clients);
  const buckets = new Map<number, number>();
  for (const part of parts) {
    for (const [bucket, count] of part.ackBuckets) buckets.set(bucket, (buckets.get(bucket) ?? 0) + count);
  }
  const seconds = Math.floor(durationMs / 1000);
  const perSecond = Array.from({ length: seconds }, (_, i) => buckets.get(i) ?? 0);
  const sortedPerSecond = [...perSecond].sort((a, b) => a - b);

  const samples = backend.probe().filter((s) => s.t >= measuredStart && s.t <= measuredStart + durationMs);
  const first = samples[0];
  const last = samples[samples.length - 1];
  const serverCpuCores = first && last && last.t > first.t
    ? (last.cpuMicros - first.cpuMicros) / 1e6 / ((last.t - first.t) / 1000) : null;

  const logText = fs.readFileSync(backend.logPath, 'utf8');
  const exitBeforeStop = backend.exitInfo();
  await backend.stop();
  proxy?.close();

  const totals = perClient.reduce((sum, c) => ({
    sent: sum.sent + c.sent,
    acked: sum.acked + c.acked,
    errors: sum.errors + c.errors,
    unacked: sum.unacked + c.unacked,
  }), { sent: 0, acked: 0, errors: 0, unacked: 0 });

  const record = {
    mode, clients, rep, label, dbDelayMs,
    env: environmentInfo(),
    postgres: await postgresSettings(pool),
    window: { warmupMs, durationMs },
    ackedOpsPerSec: latencies.length / (durationMs / 1000),
    ackedPerSecondMin: sortedPerSecond[0] ?? null,
    ackedPerSecondP5: percentile(sortedPerSecond, 5),
    ackedPerSecondMedian: percentile(sortedPerSecond, 50),
    ackedPerSecondMax: sortedPerSecond[sortedPerSecond.length - 1] ?? null,
    latencyMs: {
      samples: latencies.length,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: percentile(latencies, 100),
    },
    totals,
    convergence: {
      allArrivalOrdersIdentical: new Set(perClient.map((c) => c.arrivalHash)).size === 1,
      allContentIdentical: new Set(perClient.map((c) => c.contentHash)).size === 1,
      contentMatchesDb: perClient.every((c) => c.contentHash === audit.contentHash),
      clientsWithInversions: perClient.filter((c) => c.inversions > 0).length,
      inversionsMaxPerClient: Math.max(...perClient.map((c) => c.inversions)),
      firstInversion: perClient.find((c) => c.firstInversion)?.firstInversion ?? null,
      duplicatesTotal: perClient.reduce((sum, c) => sum + c.duplicates, 0),
      gapsTotal: perClient.reduce((sum, c) => sum + c.gaps, 0),
      receivedMin: Math.min(...perClient.map((c) => c.received)),
      receivedMax: Math.max(...perClient.map((c) => c.received)),
      socketCloses: perClient.reduce((sum, c) => sum + c.closes, 0),
    },
    db: {
      rows: audit.rows,
      minSeq: audit.minSeq,
      maxSeq: audit.maxSeq,
      distinctSeqs: audit.distinctSeqs,
      currentSeq: audit.currentSeq,
      contiguousFromOne: audit.contiguousFromOne,
      currentSeqMatchesMax: audit.currentSeqMatchesMax,
    },
    server: {
      crashed: exitBeforeStop !== null,
      exit: exitBeforeStop,
      persistFailures: (logText.match(/op persist failed/g) ?? []).length,
      cpuCores: serverCpuCores,
      eluMean: samples.length ? samples.reduce((sum, s) => sum + s.elu, 0) / samples.length : null,
      loopP99MaxMs: samples.length ? Math.max(...samples.map((s) => s.loopP99Ms)) : null,
      rssMaxMb: samples.length ? Math.max(...samples.map((s) => s.rss)) / 2 ** 20 : null,
      sumBufferedMaxMb: samples.length ? Math.max(...samples.map((s) => s.sumBuffered)) / 2 ** 20 : null,
    },
    postgresCpuCores: cpuPgStart.value !== null && cpuPgEnd !== null
      ? (cpuPgEnd - cpuPgStart.value) / pgWallSeconds : null,
    harness: {
      workers: workers.length,
      eluByWorker: parts.map((part) => Number(part.elu.toFixed(3))),
    },
    perSecond,
  };
  fs.appendFileSync(outFile, JSON.stringify(record) + '\n');
  await pool.end();

  const c = record.convergence;
  console.log(
    `${mode.padEnd(9)} c=${String(clients).padEnd(3)} rep=${rep} ` +
    `acked/s=${record.ackedOpsPerSec.toFixed(1)} minSec=${record.ackedPerSecondMin} ` +
    `p50=${record.latencyMs.p50?.toFixed(1)} p95=${record.latencyMs.p95?.toFixed(1)} p99=${record.latencyMs.p99?.toFixed(1)} ` +
    `errors=${totals.errors} unacked=${totals.unacked} inv=${c.inversionsMaxPerClient} gaps=${c.gapsTotal} dups=${c.duplicatesTotal} ` +
    `orderSame=${c.allArrivalOrdersIdentical} contentDb=${c.contentMatchesDb} dbOk=${record.db.contiguousFromOne} ` +
    `srvCpu=${record.server.cpuCores?.toFixed(2)} pgCpu=${record.postgresCpuCores?.toFixed(2)} ` +
    `harnessElu=${Math.max(...record.harness.eluByWorker)} crashed=${record.server.crashed}`,
  );
}

for (let rep = 1; rep <= reps; rep += 1) {
  for (const mode of modes) {
    for (const clients of clientCounts) {
      await runCell(mode, clients, rep);
    }
  }
}
console.log('THROUGHPUT DONE');
