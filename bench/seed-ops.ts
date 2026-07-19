// seed-ops.ts — populate the Operation table with realistic op sequences for
// benchmarking op-log replay. Idempotent: re-running wipes and reseeds only the
// dedicated bench rooms (identified by benchSlug), never touching real data.
//
// Run:  pnpm --filter bench seed            (default scales: 1000, 10000)
//       pnpm --filter bench seed 500 5000   (custom scales)
//       pnpm --filter bench seed --allow-remote   (required for non-local DBs)

import { prisma, Prisma } from "@repo/db/client";
import {
  BENCH_USER_EMAIL,
  BENCH_USER_USERNAME,
  benchSlug,
  parseScales,
  assertLocalDb,
} from "./bench-config";
import { OpGenerator, assertValidPayload, type GenOp, type OpType } from "./op-gen";

// A generated op plus the seq the seeder assigns (strictly increasing).
interface SeqOp extends GenOp {
  seq: number;
}

function generateOps(count: number): SeqOp[] {
  const gen = new OpGenerator();
  const ops: SeqOp[] = [];
  for (let i = 0; i < count; i++) {
    ops.push({ seq: i + 1, ...gen.next() });
  }
  return ops;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
async function ensureBenchUser(): Promise<string> {
  const user = await prisma.user.upsert({
    where: { email: BENCH_USER_EMAIL },
    update: {},
    create: {
      email: BENCH_USER_EMAIL,
      username: BENCH_USER_USERNAME,
      // Not a real login path — bench-replay/bench-ws sign JWTs directly.
      password: "bench-user-no-login",
      image: "",
    },
    select: { id: true },
  });
  return user.id;
}

async function seedRoom(scale: number, userId: string): Promise<void> {
  const slug = benchSlug(scale);

  // Upsert the room, then wipe *only* this room's ops/snapshots (idempotent).
  const room = await prisma.room.upsert({
    where: { slug },
    update: {},
    create: { slug, adminId: userId, currentSeq: 0 },
    select: { id: true },
  });
  await prisma.operation.deleteMany({ where: { roomId: room.id } });
  await prisma.snapshot.deleteMany({ where: { roomId: room.id } });

  const ops = generateOps(scale);

  // Validate every non-null payload against the production Zod schema so the
  // seeded data is guaranteed to be exactly what the app would accept.
  for (const op of ops) assertValidPayload(op);

  const rows = ops.map((op) => ({
    roomId: room.id,
    seq: op.seq,
    type: op.opType,
    shapeId: op.shapeId,
    payload: op.payload === null ? Prisma.JsonNull : (op.payload as Prisma.InputJsonValue),
    userId,
  }));

  // Chunk inserts to keep the pg driver comfortable at 10k+ rows.
  const CHUNK = 1000;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await prisma.operation.createMany({ data: rows.slice(i, i + CHUNK) });
  }

  // Keep Room.currentSeq consistent with the highest seq we wrote.
  await prisma.room.update({ where: { id: room.id }, data: { currentSeq: ops.length } });

  const counts = ops.reduce(
    (acc, o) => ((acc[o.opType] += 1), acc),
    { CREATE: 0, UPDATE: 0, DELETE: 0 } as Record<OpType, number>,
  );
  console.log(
    `  room ${slug} (id=${room.id}): ${ops.length} ops ` +
      `[CREATE ${counts.CREATE} / UPDATE ${counts.UPDATE} / DELETE ${counts.DELETE}], currentSeq=${ops.length}`,
  );
}

async function main() {
  const { host, allowRemote } = assertLocalDb(process.argv.slice(2));
  const scales = parseScales(process.argv.slice(2));
  console.log(`Seeding bench rooms for scales: ${scales.join(", ")}`);
  console.log(`  DB host: ${host}${allowRemote ? " (--allow-remote)" : ""}`);

  const userId = await ensureBenchUser();
  console.log(`  bench user: ${BENCH_USER_EMAIL} (id=${userId})`);

  for (const scale of scales) {
    await seedRoom(scale, userId);
  }

  console.log("Done.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
