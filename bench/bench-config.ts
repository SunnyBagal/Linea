// Shared between seed-ops.ts and bench-replay.ts so the two scripts always
// agree on which rooms/users the benchmark uses.

export const DEFAULT_SCALES = [1000, 10000];

// Dedicated benchmark identities. Nothing here collides with real Linea data:
// real room slugs are 12-hex from randomBytes, real users have real emails.
export const BENCH_USER_EMAIL = "bench@linea.local";
export const BENCH_USER_USERNAME = "linea-bench";

export function benchSlug(count: number): string {
  return `bench-${count}`;
}

// Parse trailing CLI numbers as scales, e.g. `pnpm seed 500 2000`.
// Falls back to DEFAULT_SCALES when none are given.
export function parseScales(argv: string[]): number[] {
  const nums = argv
    .map((a) => Number(a))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.floor(n));
  return nums.length > 0 ? nums : [...DEFAULT_SCALES];
}

export const HTTP_URL =
  process.env.BENCH_HTTP_URL ?? process.env.NEXT_PUBLIC_HTTP_URL ?? "http://localhost:3005";

export const WS_URL =
  process.env.BENCH_WS_URL ?? process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080";

// Dedicated room for the WebSocket throughput bench.
export const WS_ROOM_SLUG = "bench-ws";

// --- localhost DB safety guard ---------------------------------------------
// The bench scripts write real Operation rows. Refuse to run against a non-local
// DATABASE_URL unless --allow-remote is explicitly passed. Returns the DB host
// so callers can print it in their startup banner.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", ""]);

export function getDbHost(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  return new URL(url).hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
}

export function assertLocalDb(argv: string[]): { host: string; allowRemote: boolean } {
  const host = getDbHost();
  const allowRemote = argv.includes("--allow-remote");
  const isLocal = LOCAL_HOSTS.has(host);
  if (!isLocal && !allowRemote) {
    console.error(
      `\n  ✗ REFUSING TO RUN: DATABASE_URL points at a non-local host:\n` +
        `      ${host}\n\n` +
        `  This bench writes real Operation rows. If you really mean to write to\n` +
        `  that database, re-run with --allow-remote.\n`,
    );
    process.exit(1);
  }
  return { host, allowRemote };
}
