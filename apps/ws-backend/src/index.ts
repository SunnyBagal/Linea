import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@repo/backend-common/config';
import { prisma as prismaClient } from '@repo/db/client';
import { WsMessageSchema } from '@repo/common/types';
import http from 'http';

// Comma-separated allowlist. When unset (local dev) or for non-browser
// clients with no Origin header, connections are allowed — so this only
// enforces once CORS_ORIGINS is configured in prod. Token auth is unchanged
// and still happens in the 'connection' handler below.
const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function isOriginAllowed(origin: string | undefined): boolean {
  if (allowedOrigins.length === 0) return true;
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/'){
    res.writeHead(200, { 'content-type': 'text/plain'});
    res.end('ok');
    return;
  }
  res.writeHead(404).end();
});

// Railway injects PORT; fall back to 8080 for local dev.
const PORT = Number(process.env.PORT) || 8080;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const OP_QUEUE_TIMEOUT_MS = 2000;
const MAX_BATCH_OPS = 100;
const MAX_BATCH_PAYLOAD_BYTES = 4 * 1024 * 1024;
const SHUTDOWN_STEP_TIMEOUT_MS = 3000;
const wss = new WebSocketServer({
  server,
  maxPayload: MAX_FRAME_BYTES,
  verifyClient: (info: { origin: string }) => isOriginAllowed(info.origin),
});

server.listen(PORT, () => console.log(`ws server on ${PORT}`));

interface Connection {
  ws: WebSocket;
  userId: string;
  rooms: Set<number>;   
  joining: Map<number, Promise<boolean>>;
  isAlive: boolean;     
}

const connections = new Map<WebSocket, Connection>();

interface PendingOp {
  ws: WebSocket;
  userId: string;
  roomId: number;
  opType: 'CREATE' | 'UPDATE' | 'DELETE';
  shapeId: string;
  payload: unknown;
  payloadJson: string;
  receivedAt: number;
}

interface RoomQueue {
  pending: PendingOp[];
  drain: Promise<void>;
}

const roomQueues = new Map<number, RoomQueue>();
let shuttingDown = false;

function checkUser(token: string): string | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (typeof decoded === 'string' || !decoded.userId) return null;

    return decoded.userId as string;

  } catch {
    return null;
  }
}

// A client that stops reading is disconnected rather than buffered without limit.
// It catches up over HTTP when it reconnects, like after any other disconnect.
function send(ws: WebSocket, data: string) {
  if (ws.readyState !== WebSocket.OPEN) return;

  if (ws.bufferedAmount + data.length > MAX_BUFFERED_BYTES) {
    ws.terminate();
    connections.delete(ws);
    return;
  }
  ws.send(data);
}

function broadcast(roomId: number, payload: unknown, exclude?: WebSocket) {
  const data = JSON.stringify(payload);
  for (const conn of connections.values()) {
    if (conn.ws === exclude) continue;

    if (conn.rooms.has(roomId)) {
      send(conn.ws, data);
    }
  }
}

function rejectJoin(ws: WebSocket, roomId: number) {
  send(ws, JSON.stringify({
    type: 'error',
    roomId,
    message: 'Failed to join room.'
  }));
}

// Names the op, so the client can roll back the optimistic change it made for it.
function rejectOp(ws: WebSocket, op: Pick<PendingOp, 'roomId' | 'shapeId' | 'opType'>) {
  send(ws, JSON.stringify({
    type: 'error',
    roomId: op.roomId,
    shapeId: op.shapeId,
    opType: op.opType,
    message: 'Failed to apply operation.'
  }));
}

// One statement, so one database round trip and one commit however many ops it holds.
// The seq bump and the inserts are atomic and the seqs are contiguous, in batch order.
async function commitBatch(roomId: number, batch: PendingOp[]): Promise<number> {
  const count = batch.length;
  const rows = await prismaClient.$queryRaw<{ firstSeq: number | null; inserted: number }[]>`
    WITH bumped AS (
      UPDATE "Room"
      SET "currentSeq" = "currentSeq" + ${count}::int
      WHERE "id" = ${roomId}::int
      RETURNING "currentSeq"
    ), inserted AS (
      INSERT INTO "Operation" ("roomId", "seq", "type", "shapeId", "payload", "userId")
      SELECT
        ${roomId}::int,
        bumped."currentSeq" - ${count}::int + input.position::int,
        input.op_type::"OpType",
        input.shape_id,
        input.payload::jsonb,
        input.user_id
      FROM bumped, unnest(
        ${batch.map((op) => op.opType)}::text[],
        ${batch.map((op) => op.shapeId)}::text[],
        ${batch.map((op) => op.payloadJson)}::text[],
        ${batch.map((op) => op.userId)}::text[]
      ) WITH ORDINALITY AS input(op_type, shape_id, payload, user_id, position)
      RETURNING "seq"
    )
    SELECT min("seq")::int AS "firstSeq", count(*)::int AS "inserted" FROM inserted
  `;

  const firstSeq = rows[0]?.firstSeq;
  if (firstSeq == null || rows[0]?.inserted !== count) {
    throw new Error(`room ${roomId} is gone`);
  }
  return firstSeq;
}

function publishCommitted(batch: PendingOp[], firstSeq: number) {
  batch.forEach((op, index) => {
    const seq = firstSeq + index;

    broadcast(op.roomId, {
      type: 'op',
      roomId: op.roomId,
      seq,
      opType: op.opType,
      shapeId: op.shapeId,
      payload: op.payload,
      userId: op.userId,
    }, op.ws);

    send(op.ws, JSON.stringify({
      type: 'op_ack',
      roomId: op.roomId,
      shapeId: op.shapeId,
      seq,
    }));
  });
}

async function commitAndPublish(roomId: number, batch: PendingOp[]) {
  try {
    publishCommitted(batch, await commitBatch(roomId, batch));
    return;
  } catch (err) {
    if (batch.length === 1) {
      console.error('op persist failed', err);
      rejectOp(batch[0]!.ws, batch[0]!);
      return;
    }
  }

  // The whole statement rolled back. Retry one at a time so one bad op
  // (a NUL byte, an oversized shapeId) can't fail the ops batched with it.
  for (const op of batch) {
    await commitAndPublish(roomId, [op]);
  }
}

function takeBatch(queue: RoomQueue): PendingOp[] {
  const batch: PendingOp[] = [];
  let payloadBytes = 0;

  while (batch.length < MAX_BATCH_OPS) {
    const op = queue.pending[0];
    if (!op) break;

    // Past the wait limit the client gets an error, not an unbounded queue.
    if (Date.now() - op.receivedAt > OP_QUEUE_TIMEOUT_MS) {
      queue.pending.shift();
      console.error('op persist failed: expired in room queue');
      rejectOp(op.ws, op);
      continue;
    }

    payloadBytes += op.payloadJson.length;
    if (batch.length > 0 && payloadBytes > MAX_BATCH_PAYLOAD_BYTES) break;

    queue.pending.shift();
    batch.push(op);
  }
  return batch;
}

// Ops that arrive during a commit wait here and go into the next batch together,
// so slower commits automatically carry more ops, with no added delay when idle.
// Commit, broadcast and ack stay strictly in order per room.
async function drainRoom(roomId: number, queue: RoomQueue) {
  while (queue.pending.length > 0) {
    try {
      const batch = takeBatch(queue);
      if (batch.length > 0) await commitAndPublish(roomId, batch);
    } catch (err) {
      console.error('room batch failed', err);
    }
  }
  // No await between the empty check and this delete, so no op can be stranded.
  roomQueues.delete(roomId);
}

function enqueueOp(op: PendingOp) {
  const queue = roomQueues.get(op.roomId);
  if (queue) {
    queue.pending.push(op);
    return;
  }

  const created: RoomQueue = { pending: [op], drain: Promise.resolve() };
  roomQueues.set(op.roomId, created);
  created.drain = drainRoom(op.roomId, created);
}

wss.on('connection', (ws, request) => {
  const url = request.url;
  if (!url) {
    ws.close();
    return;
  }

  const token = new URLSearchParams(url.split('?')[1]).get('token') ?? '';
  const userId = checkUser(token);
  if (!userId) {
    ws.close();
    return;
  }

  connections.set(ws, { ws, userId, rooms: new Set(), joining: new Map(), isAlive: true });

  ws.on('pong', () => {
    const conn = connections.get(ws);

    if (conn) {
      conn.isAlive = true
    };
  });

  ws.on('message', async (raw) => {
    const conn = connections.get(ws);
    if (!conn) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const result = WsMessageSchema.safeParse(parsed);
    if (!result.success){
      // Frames are client-controlled, so log a capped summary and never the frame.
      const issues = result.error.issues;
      console.log("WS frame rejected:", {
        bytes: raw.toString().length,
        issueCount: issues.length,
        issues: issues.slice(0, 3).map((issue) => ({ code: issue.code, path: issue.path.slice(0, 5).join('.').slice(0, 100) })),
      });
      return;
    }
    const msg = result.data; 

    if (msg.type === 'join_room') {

      const lookup = prismaClient.room
        .findUnique({
          where: { 
            id: msg.roomId 
          },
          select: { 
            id: true 
          },
        })
        .then((room) => room !== null)
        .catch((err) => {
          console.error('join_room failed', err);
          return false;
        });

      conn.joining.set(msg.roomId, lookup);
      const found = await lookup;

      // A leave_room or a newer join_room arrived during the lookup, and it wins.
      if (conn.joining.get(msg.roomId) !== lookup) return;
      conn.joining.delete(msg.roomId);

      if (!found) {
        rejectJoin(ws, msg.roomId);
        return;
      }

      // Join first, then read the seq. Any op above that seq commits after this
      // client is a member, so it gets broadcast here. Everything up to it is
      // already in the database. Together they let the client catch up exactly.
      conn.rooms.add(msg.roomId);
      const seq = await prismaClient.room
        .findUnique({
          where: {
            id: msg.roomId
          },
          select: {
            currentSeq: true
          },
        })
        .then((room) => room?.currentSeq ?? null)
        .catch((err) => {
          console.error('join_room failed', err);
          return null;
        });

      // A leave_room during the read wins, and a newer join_room sends its own reply.
      if (!conn.rooms.has(msg.roomId) || conn.joining.has(msg.roomId)) return;

      if (seq === null) {
        conn.rooms.delete(msg.roomId);
        rejectJoin(ws, msg.roomId);
        return;
      }

      send(ws, JSON.stringify({
        type: 'room_joined',
        roomId: msg.roomId,
        seq,
      }));
      return;
    }

    if (msg.type === 'leave_room') {
      conn.joining.delete(msg.roomId);
      conn.rooms.delete(msg.roomId);
      return;
    }

    // Clients may send right after join_room, so wait for a lookup still in flight.
    if (!conn.rooms.has(msg.roomId)) {
      await conn.joining.get(msg.roomId);
    }

    if (!conn.rooms.has(msg.roomId)) {
      if (msg.type === 'op') rejectOp(ws, msg);
      return;
    }

    if (msg.type === 'chat') {

      broadcast(msg.roomId, {
        type: 'chat',
        roomId: msg.roomId,
        message: msg.message,
        userId: conn.userId,
      }, ws);

      prismaClient.chat
        .create({ 
          data: { roomId: msg.roomId, message: msg.message, userId: conn.userId } 
        })
        .catch((err) => console.error('chat persist failed', err));
      return;
    }

    if (msg.type === 'op') {
      if (shuttingDown) {
        rejectOp(ws, msg);
        return;
      }

      enqueueOp({
        ws,
        userId: conn.userId,
        roomId: msg.roomId,
        opType: msg.opType,
        shapeId: msg.shapeId,
        payload: msg.payload,
        payloadJson: JSON.stringify(msg.payload ?? null),
        receivedAt: Date.now(),
      });
      return;
    }
  });

  ws.on('close', () => {
    connections.delete(ws);   
  });

  ws.on('error', (err) => {
    console.error('ws error', err);
    connections.delete(ws);
  });
});


const HEARTBEAT_MS = 30_000;
const heartbeat = setInterval(() => {
  for (const conn of connections.values()) {
    if (!conn.isAlive) {
      conn.ws.terminate();
      connections.delete(conn.ws);
      continue;
    }
    conn.isAlive = false;
    conn.ws.ping();
  }
}, HEARTBEAT_MS);

wss.on('close', () => clearInterval(heartbeat));

function shutdownStep(step: Promise<unknown>) {
  return Promise.race([
    step,
    new Promise((resolve) => setTimeout(resolve, SHUTDOWN_STEP_TIMEOUT_MS)),
  ]);
}

// Deploys send SIGTERM. Finish queued ops so their acks go out, then close clients
// with 1001 so they know to reconnect.
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);

  await shutdownStep(Promise.allSettled([...roomQueues.values()].map((queue) => queue.drain)));

  for (const conn of connections.values()) {
    conn.ws.close(1001, 'Server restarting');
  }
  await shutdownStep(new Promise((resolve) => wss.close(resolve)));
  server.close();
  await shutdownStep(prismaClient.$disconnect());
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
