import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@repo/backend-common/config';
import { prisma as prismaClient, Prisma } from '@repo/db/client';
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
  isAlive: boolean;     
}

const connections = new Map<WebSocket, Connection>();
const roomQueues = new Map<number, Promise<void>>();

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

// Commit, broadcast and ack run one op at a time per room. Concurrent transactions
// could finish out of order, sending clients seq 6 before seq 5.
function enqueueRoomTask(roomId: number, task: () => Promise<void>) {
  const tail = (roomQueues.get(roomId) ?? Promise.resolve())
    .then(task)
    .catch((err) => console.error('room task failed', err))
    .finally(() => {
      if (roomQueues.get(roomId) === tail) roomQueues.delete(roomId);
    });
  roomQueues.set(roomId, tail);
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

  connections.set(ws, { ws, userId, rooms: new Set(), isAlive: true });

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

      try {
        const room = await prismaClient.room.findUnique({
          where: {
            id: msg.roomId
          },
          select: {
            id: true
          },
        });

        if (room) {
          conn.rooms.add(msg.roomId);
          return;
        }
      } catch (err) {
        console.error('join_room failed', err);
      }

      send(ws, JSON.stringify({
        type: 'error',
        message: 'Failed to join room.'
      }));
      return;
    }

    if (msg.type === 'leave_room') {
      conn.rooms.delete(msg.roomId);
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
      const receivedAt = Date.now();
      enqueueRoomTask(msg.roomId, async () => {
        try {
          // Past the wait limit the client gets an error, not an unbounded queue.
          if (Date.now() - receivedAt > OP_QUEUE_TIMEOUT_MS) {
            throw new Error('op expired in room queue');
          }

          const op = await prismaClient.$transaction(async (tx) => {
            const room = await tx.room.update({
              where: { 
                id: msg.roomId 
              },
              data: { 
                currentSeq: { increment: 1 } 
              },   
              select: { 
                currentSeq: true 
              },
            });

            return tx.operation.create({
              data: {
                roomId: msg.roomId,
                seq: room.currentSeq,
                type: msg.opType,
                shapeId: msg.shapeId,
                payload: msg.payload ?? Prisma.JsonNull,
                userId: conn.userId,
              },
              select: { seq: true },
            });
          });

          broadcast(msg.roomId, {
            type: 'op',
            roomId: msg.roomId,
            seq: op.seq,
            opType: msg.opType,
            shapeId: msg.shapeId,
            payload: msg.payload,
            userId: conn.userId,
          }, ws);

          send(ws, JSON.stringify({
            type: 'op_ack',
            roomId: msg.roomId,
            shapeId: msg.shapeId,
            seq: op.seq
          }));

        } catch (err) {
          console.error('op persist failed', err);
          send(ws, JSON.stringify({
            type: 'error',
            message: 'Failed to apply operation.'
          }));
        }
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