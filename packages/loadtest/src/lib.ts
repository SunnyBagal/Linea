import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import WebSocket from 'ws';

export const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(PKG_DIR, '../..');
const LOG_DIR = path.join(PKG_DIR, '.logs');

export const PG_PORT = 55433;
export const DATABASE_URL =
  process.env.LOADTEST_DATABASE_URL ?? `postgresql://postgres@127.0.0.1:${PG_PORT}/linea_loadtest`;

/** Hard stop: nothing in this package may touch a non-local database. */
export function assertLocalDatabase(url: string): void {
  const { hostname } = new URL(url);
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) {
    throw new Error(`Refusing to run against non-local database host "${hostname}"`);
  }
}
assertLocalDatabase(DATABASE_URL);

export const JWT_SECRET = randomBytes(32).toString('hex');
export const tokenFor = (userId: string) => jwt.sign({ userId }, JWT_SECRET);
export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export const LABEL = process.env.LOADTEST_LABEL ?? 'adhoc';
export const resultsDir = (label = LABEL) => path.join(PKG_DIR, 'results', label);

export function db(): pg.Pool {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  // Idle connections die during the db-outage test; that must not kill the harness.
  pool.on('error', () => {});
  return pool;
}

export async function postgresSettings(pool: pg.Pool) {
  const { rows } = await pool.query(
    `SELECT name, setting FROM pg_settings WHERE name IN ('fsync', 'synchronous_commit', 'wal_sync_method', 'full_page_writes')`,
  );
  const version = await pool.query('SHOW server_version');
  return {
    version: version.rows[0].server_version as string,
    ...Object.fromEntries(rows.map((row) => [row.name, row.setting])),
  };
}

export async function seedUser(pool: pg.Pool): Promise<string> {
  const id = `lt-user-${randomBytes(6).toString('hex')}`;
  await pool.query(
    `INSERT INTO "User" (id, email, password, username, "updatedAt") VALUES ($1, $2, 'x', 'loadtest', now())`,
    [id, `${id}@loadtest.invalid`],
  );
  return id;
}

export async function seedRoom(pool: pg.Pool, adminId: string): Promise<number> {
  const slug = `lt-${randomBytes(6).toString('hex')}`;
  const { rows } = await pool.query(
    `INSERT INTO "Room" (slug, "adminId") VALUES ($1, $2) RETURNING id`,
    [slug, adminId],
  );
  return rows[0].id as number;
}

export interface Backend {
  proc: ChildProcess;
  port: number;
  logPath: string;
  probePath: string;
  url: string;
  alive(): Promise<boolean>;
  stop(signal?: NodeJS.Signals): Promise<void>;
  waitForExit(timeoutMs: number): Promise<boolean>;
  exitInfo(): { code: number | null; signal: string | null } | null;
  logBytes(): number;
  logTail(lines?: number): string;
  probe(): ProbeSample[];
}

export interface ProbeSample {
  t: number;
  rss: number;
  heapUsed: number;
  external: number;
  cpuMicros: number;
  elu: number;
  loopP99Ms: number;
  loopMaxMs: number;
  sumBuffered: number;
  maxBuffered: number;
  sockets: number;
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (open) return;
    await sleep(50);
  }
  throw new Error(`port ${port} did not open within ${timeoutMs}ms`);
}

let backendCounter = 0;

/**
 * A TCP proxy to the local Postgres that delays database responses. Per-connection
 * order is kept, but random delays let replies from different connections overtake
 * each other, which makes the commit-order race reproducible within seconds.
 */
export async function startDbProxy(delay: () => number): Promise<{ url: string; close(): void }> {
  const target = new URL(DATABASE_URL);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port), target.hostname);
    sockets.add(client);
    sockets.add(upstream);
    let releaseAt = 0;
    client.pipe(upstream);
    upstream.on('data', (chunk) => {
      releaseAt = Math.max(releaseAt, Date.now() + delay());
      setTimeout(() => { if (!client.destroyed) client.write(chunk); }, releaseAt - Date.now());
    });
    const closeBoth = () => { client.destroy(); upstream.destroy(); };
    for (const socket of [client, upstream]) {
      socket.on('error', closeBoth);
      socket.on('close', closeBoth);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  const url = new URL(DATABASE_URL);
  url.port = String(port);
  return {
    url: url.toString(),
    close() {
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}

export async function startBackend(
  kind: 'ws' | 'http',
  port: number,
  name: string,
  options: { databaseUrl?: string } = {},
): Promise<Backend> {
  const databaseUrl = options.databaseUrl ?? DATABASE_URL;
  assertLocalDatabase(databaseUrl);
  const entry = path.join(REPO_ROOT, 'apps', `${kind}-backend`, 'dist', 'index.js');
  if (!fs.existsSync(entry)) throw new Error(`${entry} missing: run pnpm build:servers first`);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const stem = path.join(LOG_DIR, `${name}-${kind}-${process.pid}-${++backendCounter}`);
  const logPath = `${stem}.log`;
  const probePath = `${stem}.probe.jsonl`;
  const log = fs.openSync(logPath, 'w');

  // A minimal explicit env: the real shell env and any .env values stay out.
  // dotenv never overrides variables that are already set.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    NODE_ENV: 'production',
    DATABASE_URL: databaseUrl,
    DIRECT_DATABASE_URL: databaseUrl,
    JWT_SECRET,
    PORT: String(port),
    LOADTEST_PROBE_FILE: probePath,
  };
  const args = kind === 'ws'
    ? ['--require', path.join(PKG_DIR, 'src', 'probe.cjs'), entry]
    : [entry];
  const proc = spawn(process.execPath, args, { cwd: PKG_DIR, env, stdio: ['ignore', log, log] });
  fs.closeSync(log);

  let exit: { code: number | null; signal: string | null } | null = null;
  const exited = new Promise<void>((resolve) => {
    proc.once('exit', (code, signal) => { exit = { code, signal }; resolve(); });
  });
  await waitForPort(port, 15_000);

  return {
    proc,
    port,
    logPath,
    probePath,
    url: `ws://127.0.0.1:${port}`,
    async alive() {
      if (exit) return false;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
        return res.ok;
      } catch {
        return false;
      }
    },
    async stop(signal = 'SIGKILL') {
      if (!exit) proc.kill(signal);
      await exited;
    },
    async waitForExit(timeoutMs) {
      await Promise.race([exited, sleep(timeoutMs)]);
      return exit !== null;
    },
    exitInfo: () => exit,
    logBytes: () => fs.statSync(logPath).size,
    logTail(lines = 15) {
      return fs.readFileSync(logPath, 'utf8').split('\n').slice(-lines).join('\n').slice(-2000);
    },
    probe() {
      if (!fs.existsSync(probePath)) return [];
      return fs.readFileSync(probePath, 'utf8').trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line) as ProbeSample);
    },
  };
}

export function rectOp(roomId: number, shapeId: string, opType: 'CREATE' | 'UPDATE' | 'DELETE' = 'CREATE') {
  return {
    type: 'op',
    roomId,
    opType,
    shapeId,
    payload: opType === 'DELETE' ? null : { id: shapeId, type: 'rect', x: 10, y: 20, width: 100, height: 50 },
  };
}

export function textOp(roomId: number, shapeId: string, textBytes: number) {
  return {
    type: 'op',
    roomId,
    opType: 'CREATE',
    shapeId,
    payload: { id: shapeId, type: 'text', x: 1, y: 2, fontSize: 12, text: 'x'.repeat(textBytes) },
  };
}

/** A client that records everything it sees, for the chaos tests. */
export class TestClient {
  ws!: WebSocket;
  frames: any[] = [];
  closeCode: number | null = null;
  private waiters: Array<() => void> = [];

  static async connect(url: string, token: string): Promise<TestClient> {
    const client = new TestClient();
    await client.open(url, token);
    return client;
  }

  open(url: string, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.closeCode = null;
      this.ws = new WebSocket(`${url}?token=${token}`, { maxPayload: 512 * 1024 * 1024 });
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
      this.ws.on('error', () => {});
      this.ws.on('message', (raw) => {
        this.frames.push(JSON.parse(raw.toString()));
        this.notify();
      });
      this.ws.on('close', (code) => {
        this.closeCode = code;
        this.notify();
      });
    });
  }

  private notify() {
    for (const waiter of this.waiters.splice(0)) waiter();
  }

  get isOpen() { return this.ws.readyState === WebSocket.OPEN; }
  send(value: unknown) { this.ws.send(typeof value === 'string' ? value : JSON.stringify(value)); }
  join(roomId: number) { this.send({ type: 'join_room', roomId }); }
  ofType(type: string) { return this.frames.filter((frame) => frame.type === type); }
  ackFor(shapeId: string) { return this.frames.find((f) => f.type === 'op_ack' && f.shapeId === shapeId); }

  /** Resolves true once the predicate holds, false on timeout. */
  async waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
    return true;
  }

  terminate() { this.ws.terminate(); }
  close() { if (this.ws.readyState <= WebSocket.OPEN) this.ws.close(); }
}

export const contentLine = (seq: number, shapeId: string) => `${seq}:${shapeId}\n`;

export function hashLines(lines: string[]): string {
  const hash = createHash('sha256');
  for (const line of lines) hash.update(line);
  return hash.digest('hex').slice(0, 16);
}

export interface DbAudit {
  rows: number;
  minSeq: number | null;
  maxSeq: number | null;
  distinctSeqs: number;
  currentSeq: number;
  missingSeqs: number;
  contiguousFromOne: boolean;
  currentSeqMatchesMax: boolean;
  contentHash: string;
  bySeq: Map<number, string>;
}

export async function auditRoom(pool: pg.Pool, roomId: number): Promise<DbAudit> {
  const { rows } = await pool.query(
    `SELECT seq, "shapeId" FROM "Operation" WHERE "roomId" = $1 ORDER BY seq`, [roomId],
  );
  const room = await pool.query(`SELECT "currentSeq" FROM "Room" WHERE id = $1`, [roomId]);
  const currentSeq = room.rows[0].currentSeq as number;
  const seqs = rows.map((row) => row.seq as number);
  const minSeq = seqs.length ? seqs[0]! : null;
  const maxSeq = seqs.length ? seqs[seqs.length - 1]! : null;
  const distinctSeqs = new Set(seqs).size;
  return {
    rows: rows.length,
    minSeq,
    maxSeq,
    distinctSeqs,
    currentSeq,
    missingSeqs: maxSeq === null ? 0 : maxSeq - distinctSeqs,
    contiguousFromOne: seqs.length === 0 || (minSeq === 1 && maxSeq === seqs.length && distinctSeqs === seqs.length),
    currentSeqMatchesMax: currentSeq === (maxSeq ?? 0),
    contentHash: hashLines(rows.map((row) => contentLine(row.seq, row.shapeId))),
    bySeq: new Map(rows.map((row) => [row.seq as number, row.shapeId as string])),
  };
}

/** Total CPU seconds of the local Postgres backends, read from `ps`. */
export function postgresCpuSeconds(): number | null {
  try {
    const pidFile = path.join(PKG_DIR, '.pg', 'postmaster.pid');
    const postmaster = fs.readFileSync(pidFile, 'utf8').split('\n')[0]!.trim();
    const output = execFileSync('ps', ['-ax', '-o', 'ppid=,time='], { encoding: 'utf8' });
    let total = 0;
    for (const line of output.split('\n')) {
      const [ppid, time] = line.trim().split(/\s+/);
      if (ppid !== postmaster || !time) continue;
      total += time.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
    }
    return total;
  } catch {
    return null;
  }
}

export function environmentInfo() {
  const git = (...args: string[]) => {
    try {
      return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  };
  return {
    gitSha: git('rev-parse', 'HEAD'),
    serverSourceDirty: Boolean(git('status', '--porcelain', 'apps/ws-backend', 'packages/common', 'packages/db')),
    cpu: os.cpus()[0]?.model,
    cores: os.cpus().length,
    memGb: Math.round(os.totalmem() / 2 ** 30),
    platform: `${os.platform()} ${os.release()}`,
    node: process.version,
  };
}

export function percentile(sorted: ArrayLike<number>, p: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

/** Collects named checks and facts so one failure does not hide the rest. */
export class CaseRecord {
  checks: Array<{ name: string; pass: boolean; detail?: unknown }> = [];
  facts: Record<string, unknown> = {};

  constructor(private readonly name: string) {}

  check(name: string, pass: boolean, detail?: unknown) {
    this.checks.push({ name, pass, detail });
  }

  fact(name: string, value: unknown) {
    this.facts[name] = value;
  }

  /** Writes the raw result, then throws if any check failed. */
  finish() {
    const dir = path.join(resultsDir(), 'chaos');
    fs.mkdirSync(dir, { recursive: true });
    const failed = this.checks.filter((check) => !check.pass);
    fs.writeFileSync(path.join(dir, `${this.name}.json`), JSON.stringify({
      case: this.name,
      pass: failed.length === 0,
      env: environmentInfo(),
      checks: this.checks,
      facts: this.facts,
    }, null, 2) + '\n');
    if (failed.length > 0) {
      throw new Error(`Failed checks:\n${failed.map((check) =>
        ` - ${check.name}: ${JSON.stringify(check.detail ?? null)}`).join('\n')}`);
    }
  }
}

export interface Stack {
  pool: pg.Pool;
  ws: Backend;
  userId: string;
  token: string;
  roomId: number;
  wsPort: number;
  shutdown(): Promise<void>;
}

const WS_PORT = 18080;

/** A fresh ws-backend, a user and a room, for one test case. */
export async function startStack(name: string, options: { databaseUrl?: string } = {}): Promise<Stack> {
  const pool = db();
  const userId = await seedUser(pool);
  const roomId = await seedRoom(pool, userId);
  const ws = await startBackend('ws', WS_PORT, name, options);
  return {
    pool,
    ws,
    userId,
    token: tokenFor(userId),
    roomId,
    wsPort: WS_PORT,
    async shutdown() {
      await ws.stop();
      await pool.end();
    },
  };
}
