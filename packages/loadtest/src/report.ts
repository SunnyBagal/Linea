// Prints markdown tables from the raw results of one or more labels.
// Usage: tsx src/report.ts before [fsync-true ...]
import fs from 'node:fs';
import path from 'node:path';
import { resultsDir } from './lib.ts';

const fmt = (value: number | null | undefined, digits = 1) =>
  value === null || value === undefined ? 'n/a' : value.toFixed(digits);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

function throughputSection(label: string): string {
  const file = path.join(resultsDir(label), 'throughput.jsonl');
  if (!fs.existsSync(file)) return '';
  const records = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const first = records[0];
  const out: string[] = [
    `### Throughput: \`${label}\``,
    '',
    `Commit \`${first.env.gitSha}\`, ${first.env.cpu}, ${first.env.cores} cores, ${first.env.memGb} GB, ` +
      `${first.env.platform}, Node ${first.env.node}. Postgres ${first.postgres.version}: ` +
      `fsync=${first.postgres.fsync}, synchronous_commit=${first.postgres.synchronous_commit}, ` +
      `wal_sync_method=${first.postgres.wal_sync_method}. ` +
      `${first.window.durationMs / 1000}s measured after ${first.window.warmupMs / 1000}s warm-up, fresh server and room per run.`,
    '',
    '| mode | clients | rep | acked/s | worst 1s | p50 ms | p95 ms | p99 ms | max ms | errors | unacked | ops per commit | server CPU | PG CPU | harness ELU |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of records) {
    out.push(`| ${r.mode} | ${r.clients} | ${r.rep} | ${fmt(r.ackedOpsPerSec)} | ${r.ackedPerSecondMin} | ` +
      `${fmt(r.latencyMs.p50)} | ${fmt(r.latencyMs.p95)} | ${fmt(r.latencyMs.p99)} | ${fmt(r.latencyMs.max)} | ` +
      `${r.totals.errors} | ${r.totals.unacked} | ${fmt(r.opsPerCommit, 2)} | ${fmt(r.server.cpuCores, 2)} | ${fmt(r.postgresCpuCores, 2)} | ` +
      `${Math.max(...r.harness.eluByWorker).toFixed(2)} |`);
  }

  out.push('', 'Median across reps:', '',
    '| mode | clients | reps | acked/s | worst 1s | p50 ms | p95 ms | p99 ms |', '|---|---|---|---|---|---|---|---|');
  const groups = new Map<string, any[]>();
  for (const r of records) {
    const key = `${r.mode}|${r.clients}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const [key, rows] of groups) {
    const [mode, clients] = key.split('|');
    out.push(`| ${mode} | ${clients} | ${rows.length} | ${fmt(median(rows.map((r) => r.ackedOpsPerSec)))} | ` +
      `${median(rows.map((r) => r.ackedPerSecondMin))} | ${fmt(median(rows.map((r) => r.latencyMs.p50)))} | ` +
      `${fmt(median(rows.map((r) => r.latencyMs.p95)))} | ${fmt(median(rows.map((r) => r.latencyMs.p99)))} |`);
  }

  out.push('', 'Convergence (arrival order compares all clients; inversions are seqs arriving after a higher seq):', '',
    '| mode | clients | rep | same arrival order | content = DB | clients with inversions | max inversions | gaps | dups | DB contiguous | currentSeq = max | DB rows | persist failures | crashed |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of records) {
    const c = r.convergence;
    out.push(`| ${r.mode} | ${r.clients} | ${r.rep} | ${c.allArrivalOrdersIdentical} | ${c.contentMatchesDb} | ` +
      `${c.clientsWithInversions}/${r.clients} | ${c.inversionsMaxPerClient} | ${c.gapsTotal} | ${c.duplicatesTotal} | ` +
      `${r.db.contiguousFromOne} | ${r.db.currentSeqMatchesMax} | ${r.db.rows} | ${r.server.persistFailures} | ${r.server.crashed} |`);
  }
  return out.join('\n');
}

function chaosSection(label: string): string {
  const dir = path.join(resultsDir(label), 'chaos');
  if (!fs.existsSync(dir)) return '';
  const cases = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  const out = [`### Chaos: \`${label}\``, '', `Commit \`${cases[0]?.env.gitSha}\`.`, '',
    '| case | result | failed checks |', '|---|---|---|'];
  for (const c of cases) {
    const failed = c.checks.filter((check: any) => !check.pass).map((check: any) => check.name).join('; ');
    out.push(`| ${c.case} | ${c.pass ? 'pass' : 'FAIL'} | ${failed} |`);
  }
  out.push('', 'Measured facts per case:', '');
  for (const c of cases) {
    out.push(`<details><summary>${c.case}</summary>`, '', '```json', JSON.stringify(c.facts, null, 1), '```', '', '</details>', '');
  }
  return out.join('\n');
}

for (const label of process.argv.slice(2)) {
  for (const section of [throughputSection(label), chaosSection(label)]) {
    if (section) console.log(`${section}\n`);
  }
}
