import { WebSocketServer, WebSocket } from 'ws';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '@repo/backend-common/config';
import { prisma as prismaClient } from '@repo/db/client';
import { WsMessageSchema } from '@repo/common/types';

const wss = new WebSocketServer({ port: 8080 });

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
    if (!result.success) return;
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
              payload: msg.payload ?? undefined,
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

console.log('websocket server running on ws://localhost:8080');