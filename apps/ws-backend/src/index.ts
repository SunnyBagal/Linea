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
const wss = new WebSocketServer({
  server,
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

function checkUser(token: string): string | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (typeof decoded === 'string' || !decoded.userId) return null;

    return decoded.userId as string;

  } catch {
    return null;
  }
}

function broadcast(roomId: number, payload: unknown, exclude?: WebSocket) {
  const data = JSON.stringify(payload);
  for (const conn of connections.values()) {
    if (conn.ws === exclude) continue;
    
    if (conn.rooms.has(roomId) && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(data);
    }
  }
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
      console.log("WS frome rejected: ", result.error.issues);
      console.log(" raw frame was:", raw.toString());
      return;
    }
    const msg = result.data; 

    if (msg.type === 'join_room') {

      const room = await prismaClient.room.findUnique({
        where: { 
          id: msg.roomId 
        },
        select: { 
          id: true 
        },
      });

      if (room) {
        conn.rooms.add(msg.roomId)
      };

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
      try {
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

        ws.send(JSON.stringify({
          type: 'op_ack',
          roomId: msg.roomId,
          shapeId: msg.shapeId,
          seq: op.seq
        }));

      } catch (err) {
        console.error('op persist failed', err);
        ws.send(JSON.stringify({ 
          type: 'error', 
          message: 'Failed to apply operation.' 
        }));
      }
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