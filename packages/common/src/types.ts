import { z } from 'zod';

export const CreateUserSchema = z.object({
  username: z.string().min(3).max(20),
  email: z.email(),
  password: z.string().min(8).max(100),
});

export const SigninSchema = z.object({
  email: z.email(),
  password: z.string().min(8).max(100),
});

export const CreateRoomSchema = z.object({
  slug: z.string().min(3).max(20),
});

const PointSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const ShapeGeometrySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    x: z.number(),
    y: z.number(),
    text: z.string(),
    fontSize: z.number(),
  }),
  z.object({
    type: z.literal('rect'),
    x: z.number(), y: z.number(),
    width: z.number(), height: z.number(),
  }),
  z.object({
    type: z.literal('circle'),
    centerX: z.number(), centerY: z.number(), radius: z.number(),
  }),
  z.object({
    type: z.literal('line'),
    x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(),
  }),
  z.object({
    type: z.literal('arrow'),
    x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(),
  }),
  z.object({
    type: z.literal('pencil'),
    points: z.array(PointSchema).min(2),
  }),
]);

export const ShapeSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string(),
    type: z.literal('text'),
    x: z.number(),
    y: z.number(),
    text: z.string(),
    fontSize: z.number(),
  }),
  z.object({
    id: z.string(),
    type: z.literal('rect'),
    x: z.number(), y: z.number(),
    width: z.number(), height: z.number(),
  }),
  z.object({
    id: z.string(),
    type: z.literal('circle'),
    centerX: z.number(), centerY: z.number(), radius: z.number(),
  }),
  z.object({
    id: z.string(),
    type: z.literal('line'),
    x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(),
  }),
  z.object({
    id: z.string(),
    type: z.literal('arrow'),
    x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(),
  }),
  z.object({
    id: z.string(),
    type: z.literal('pencil'),
    points: z.array(PointSchema).min(2),
  }),
]);


const JoinRoomSchema = z.object({
  type: z.literal('join_room'),
  roomId: z.number().int()
});

const LeaveRoomSchema = z.object({
  type: z.literal('leave_room'),
  roomId: z.number().int()
});

const ChatSchema = z.object({
  type: z.literal('chat'),
  roomId: z.number().int(),
  message: z.string().min(1).max(100000)
});

const OpSchema = z.object({
  type: z.literal('op'),
  roomId: z.number().int(),
  opType: z.enum(['CREATE','UPDATE','DELETE']),
  shapeId: z.string(),
  payload: ShapeSchema.nullable(),
});

export const WsMessageSchema = z.discriminatedUnion('type', [
  JoinRoomSchema,
  LeaveRoomSchema,
  ChatSchema,
  OpSchema,
]);

export type WsMessage = z.infer<typeof WsMessageSchema>;
export type OpMessage = z.infer<typeof OpSchema>;
export type ShapeGeometry = z.infer<typeof ShapeGeometrySchema>;
export type Shape = z.infer<typeof ShapeSchema>;