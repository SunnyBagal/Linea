import { test } from 'node:test';
import {
  auditRoom, CaseRecord, rectOp, seedUser, sleep, startDbProxy, startStack, textOp, tokenFor, TestClient,
} from '../src/lib.ts';
import { uid } from './helpers.ts';

/** jsonb does not keep key order, so compare payloads with sorted keys. */
const canonical = (value: unknown) => JSON.stringify(value, (_key, v) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
    : v);

const MAX_BATCH_OPS = 100;
const MAX_BATCH_BYTES = 4 * 2 ** 20;

/** Rows from one statement share a createdAt, so this groups rows by commit. */
async function commitGroups(pool: import('pg').Pool, roomId: number) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS ops, sum(octet_length(payload::text))::bigint AS bytes
     FROM "Operation" WHERE "roomId" = $1 GROUP BY "createdAt"`,
    [roomId],
  );
  return rows.map((row) => ({ ops: row.ops as number, bytes: Number(row.bytes) }));
}

test('group commit: a burst shares commits, stays contiguous and respects the op cap', async () => {
  const record = new CaseRecord('group-commit-burst');
  const proxy = await startDbProxy(() => 5);
  const stack = await startStack('group-commit-burst', { databaseUrl: proxy.url });
  try {
    const writers = await Promise.all(Array.from({ length: 4 }, () => TestClient.connect(stack.ws.url, stack.token)));
    const observer = await TestClient.connect(stack.ws.url, stack.token);
    for (const client of [...writers, observer]) client.join(stack.roomId);
    await sleep(300);

    const perWriter = 250;
    const sent: string[][] = writers.map(() => []);
    for (let i = 0; i < perWriter; i += 1) {
      writers.forEach((writer, w) => {
        const shapeId = uid(`w${w}`);
        sent[w]!.push(shapeId);
        writer.send(rectOp(stack.roomId, shapeId));
      });
    }
    const total = perWriter * writers.length;
    await observer.waitFor(() => observer.ofType('op').length >= total, 15_000);

    const audit = await auditRoom(stack.pool, stack.roomId);
    const groups = await commitGroups(stack.pool, stack.roomId);
    const observed = observer.ofType('op').map((f) => f.seq as number);
    const inOrder = observed.every((seq, i) => seq === i + 1);
    const ackOrderKept = writers.every((writer, w) =>
      writer.ofType('op_ack').every((ack, i) => ack.shapeId === sent[w]![i]));
    const ackMatchesDb = writers.every((writer) =>
      writer.ofType('op_ack').every((ack) => audit.bySeq.get(ack.seq) === ack.shapeId));

    record.fact('rows', audit.rows);
    record.fact('commits', groups.length);
    record.fact('largestCommitOps', Math.max(...groups.map((g) => g.ops)));
    record.check('every op persisted', audit.rows === total, { rows: audit.rows, total });
    record.check('ops share commits', groups.length < total / 2, { commits: groups.length, total });
    record.check('no commit exceeds the op cap', groups.every((g) => g.ops <= MAX_BATCH_OPS));
    record.check('database seq contiguous', audit.contiguousFromOne && audit.currentSeqMatchesMax);
    record.check('observer gets seqs 1..N in order', inOrder && observed.length === total, { received: observed.length });
    record.check('each writer gets acks in send order', ackOrderKept);
    record.check('acks match database rows', ackMatchesDb);
    for (const client of [...writers, observer]) client.close();
  } finally {
    await stack.shutdown();
    proxy.close();
  }
  record.finish();
});

test('group commit: an op costs one database reply', async () => {
  const record = new CaseRecord('group-commit-round-trips');
  let replies = 0;
  const proxy = await startDbProxy(() => { replies += 1; return 5; });
  const stack = await startStack('group-commit-round-trips', { databaseUrl: proxy.url });
  try {
    const writer = await TestClient.connect(stack.ws.url, stack.token);
    writer.join(stack.roomId);
    await writer.waitFor(() => writer.ofType('room_joined').length === 1, 3000);
    await sleep(100);

    const perOp: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const before = replies;
      writer.send(rectOp(stack.roomId, uid('single')));
      await writer.waitFor(() => writer.ofType('op_ack').length === i + 1, 3000);
      perOp.push(replies - before);
      await sleep(50);
    }
    record.fact('repliesPerOp', perOp);
    record.check('each lone op takes one database reply', perOp.every((count) => count === 1), perOp);
    writer.close();
  } finally {
    await stack.shutdown();
    proxy.close();
  }
  record.finish();
});

test('group commit: batches respect the byte cap', async () => {
  const record = new CaseRecord('group-commit-byte-cap');
  const proxy = await startDbProxy(() => 20);
  const stack = await startStack('group-commit-byte-cap', { databaseUrl: proxy.url });
  try {
    const writer = await TestClient.connect(stack.ws.url, stack.token);
    writer.join(stack.roomId);
    await sleep(300);

    const total = 30;
    const opBytes = 900 * 1024;
    for (let i = 0; i < total; i += 1) writer.send(textOp(stack.roomId, uid('big'), opBytes));
    await writer.waitFor(() => writer.ofType('op_ack').length + writer.ofType('error').length >= total, 20_000);

    const groups = await commitGroups(stack.pool, stack.roomId);
    const audit = await auditRoom(stack.pool, stack.roomId);
    record.fact('acked', writer.ofType('op_ack').length);
    record.fact('groups', groups);
    record.check('ops were answered', writer.ofType('op_ack').length + writer.ofType('error').length === total);
    record.check('some ops shared a commit', groups.some((g) => g.ops > 1), groups);
    record.check('no commit exceeds the byte cap', groups.every((g) => g.bytes <= MAX_BATCH_BYTES), groups);
    record.check('database seq contiguous', audit.contiguousFromOne && audit.currentSeqMatchesMax);
    writer.close();
  } finally {
    await stack.shutdown();
    proxy.close();
  }
  record.finish();
});

test('group commit: one bad op does not fail the ops batched with it', async () => {
  const record = new CaseRecord('group-commit-poison');
  const proxy = await startDbProxy(() => 5);
  const stack = await startStack('group-commit-poison', { databaseUrl: proxy.url });
  try {
    const writer = await TestClient.connect(stack.ws.url, stack.token);
    const observer = await TestClient.connect(stack.ws.url, stack.token);
    writer.join(stack.roomId);
    observer.join(stack.roomId);
    await sleep(300);

    // Fill the first commit so the rest queue up and batch together.
    const good: string[] = [];
    const bad = new Set<string>();
    for (let i = 0; i < 90; i += 1) {
      if (i % 30 === 15) {
        // Postgres rejects NUL bytes, which fails the whole statement.
        const shapeId = `bad\u0000${i}`;
        bad.add(shapeId);
        writer.send({ ...rectOp(stack.roomId, shapeId), payload: { id: 'x', type: 'text', x: 1, y: 2, fontSize: 1, text: 'a\u0000b' } });
      } else {
        const shapeId = uid('good');
        good.push(shapeId);
        writer.send(rectOp(stack.roomId, shapeId));
      }
    }
    await writer.waitFor(() => writer.ofType('op_ack').length + writer.ofType('error').length >= 90, 10_000);

    const audit = await auditRoom(stack.pool, stack.roomId);
    const persisted = new Set(audit.bySeq.values());
    const ackOrder = writer.ofType('op_ack').map((f) => f.shapeId as string);

    record.fact('acked', ackOrder.length);
    record.fact('errors', writer.ofType('error').length);
    record.check('every good op persisted', good.every((id) => persisted.has(id)));
    record.check('every good op acked in send order', JSON.stringify(ackOrder) === JSON.stringify(good));
    record.check('every bad op gets an error', writer.ofType('error').length === bad.size,
      { errors: writer.ofType('error').length, bad: bad.size });
    record.check('no bad op persisted', [...bad].every((id) => !persisted.has(id)));
    record.check('failures do not burn seqs', audit.contiguousFromOne && audit.currentSeqMatchesMax,
      { rows: audit.rows, currentSeq: audit.currentSeq });
    writer.close();
    observer.close();
  } finally {
    await stack.shutdown();
    proxy.close();
  }
  record.finish();
});

test('group commit: rows keep each op type, payload and author', async () => {
  const record = new CaseRecord('group-commit-fidelity');
  const proxy = await startDbProxy(() => 5);
  const stack = await startStack('group-commit-fidelity', { databaseUrl: proxy.url });
  try {
    const otherUser = await seedUser(stack.pool);
    const alice = await TestClient.connect(stack.ws.url, stack.token);
    const bob = await TestClient.connect(stack.ws.url, tokenFor(otherUser));
    alice.join(stack.roomId);
    bob.join(stack.roomId);
    await sleep(300);

    const expected = new Map<string, { type: string; userId: string; payload: unknown }>();
    for (let i = 0; i < 60; i += 1) {
      const fromAlice = i % 2 === 0;
      const opType = (['CREATE', 'UPDATE', 'DELETE'] as const)[i % 3]!;
      const shapeId = uid(opType);
      const frame = rectOp(stack.roomId, shapeId, opType);
      (fromAlice ? alice : bob).send(frame);
      expected.set(shapeId, { type: opType, userId: fromAlice ? stack.userId : otherUser, payload: frame.payload });
    }
    await alice.waitFor(() => alice.ofType('op_ack').length + alice.ofType('op').length >= 60, 10_000);
    await sleep(200);

    const { rows } = await stack.pool.query(
      `SELECT seq, type, "shapeId", payload, "userId" FROM "Operation" WHERE "roomId" = $1 ORDER BY seq`,
      [stack.roomId],
    );
    const mismatches = rows.filter((row) => {
      const want = expected.get(row.shapeId);
      return !want || want.type !== row.type || want.userId !== row.userId
        || canonical(want.payload) !== canonical(row.payload);
    });
    const broadcastsOk = alice.ofType('op').every((f) => {
      const want = expected.get(f.shapeId);
      return want && want.userId === f.userId && want.type === f.opType
        && canonical(want.payload ?? null) === canonical(f.payload ?? null);
    });

    record.fact('rows', rows.length);
    record.check('all rows persisted', rows.length === 60, { rows: rows.length });
    record.check('rows match what was sent', mismatches.length === 0, { mismatches: mismatches.length });
    record.check('broadcasts match what was sent', broadcastsOk);
    alice.close();
    bob.close();
  } finally {
    await stack.shutdown();
    proxy.close();
  }
  record.finish();
});

test('group commit: an op for a deleted room gets an error', async () => {
  const record = new CaseRecord('group-commit-deleted-room');
  const stack = await startStack('group-commit-deleted-room');
  try {
    const writer = await TestClient.connect(stack.ws.url, stack.token);
    writer.join(stack.roomId);
    await sleep(200);
    await stack.pool.query(`DELETE FROM "Room" WHERE id = $1`, [stack.roomId]);

    writer.send(rectOp(stack.roomId, uid('gone')));
    const answered = await writer.waitFor(() => writer.ofType('error').length === 1, 3000);
    record.check('sender gets an error', answered, { replies: writer.frames.map((f) => f.type) });
    record.check('server stays up', await stack.ws.alive());
    writer.close();
  } finally {
    await stack.shutdown();
  }
  record.finish();
});
