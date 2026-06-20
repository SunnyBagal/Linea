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

export const ShapeSchema = z.object({
  type: z.enum(['rect', 'ellipse', 'line', 'arrow', 'text', 'freedraw']),
  x: z.number(),
  y: z.number()
});

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
  message: z.string().min(1).max(2000)
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