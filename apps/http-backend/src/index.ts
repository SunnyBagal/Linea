import express from 'express';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { Prisma } from '@repo/db/client';            
import { authMiddleware } from './middleware/middleware';
import { JWT_SECRET } from "@repo/backend-common/config";
import { CreateRoomSchema, CreateUserSchema, SigninSchema } from "@repo/common/types";
import { prisma } from "@repo/db/client";

const app = express();
app.use(express.json());

app.post("/signup", async (req, res) => {

  const parsed = CreateUserSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ 
      message: "Incorrect inputs" 
    });
  }

  const { username, email, password } = parsed.data;

  const hashedPassword = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 32768,
    timeCost: 3,
    parallelism: 1,
  });

  try {
    const user = await prisma.user.create({
      data: { 
        email, username, password: hashedPassword, image: "" 
      },
      select: { 
        id: true,
        username: true,
        email: true 
      },
    });
    return res.status(201).json({ 
      userId: user.id,
      username: user.username,
    });

  } catch (error) {

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {

      return res.status(409).json({ 
        message: "User already exists." 
      });
    }
    console.error(error);
    return res.status(500).json({ 
      message: "Issue creating account." 
    });
  }
});

app.post("/signin", async (req, res) => {
  const parsed = SigninSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ 
      message: "Incorrect inputs" 
    });
  }

  const { email, password } = parsed.data;

  const user = await prisma.user.findFirst({ 
    where: { email } 
  });

  if (!user || !(await argon2.verify(user.password, password))) {
    return res.status(403).json({ 
      message: "Invalid email or password." 
    });

  }

  const token = jwt.sign({ 
    userId: user.id 
  }, JWT_SECRET, { expiresIn: "7d" });

  return res.json({ 
    token 
  });

});

app.post("/room", authMiddleware, async (req, res) => {

  const parsed = CreateRoomSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({ 
      message: "Incorrect inputs" 
    });
  }
  const { slug } = parsed.data;
  const adminId = req.userId;  

  if (!adminId) {
    return res.status(401).json({
      message: "Unauthorized"
    });
  }

  try {
    const room = await prisma.room.create({
      data: { 
        slug, adminId 
      },
      select: { id: true },
    });

    return res.status(201).json({ 
      roomId: room.id 
    });

  } catch (error) {

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return res.status(409).json({ 
        message: "Room name already taken." 
      });
    }

    console.error(error);
    return res.status(500).json({ 
      message: "Could not create room." 
    });

  }
});

app.get("/chats/:roomId", authMiddleware, async (req, res) => {

  const roomId = Number(req.params.roomId);
  if (Number.isNaN(roomId)) {
    return res.status(400).json({ message: "Invalid room id" });
  }

  try {
    const messages = await prisma.chat.findMany({
      where: { 
        roomId 
      },
      orderBy: { 
        createdAt: "desc" 
      },
      take: 50,
    });

    return res.json({ 
      messages: messages.reverse() 
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({ 
      message: "Could not fetch chats." 
    });
  }
});

app.get("/room/:slug", authMiddleware, async (req, res) => {
  const slug = req.params.slug;
  if (typeof slug !== "string") {
    return res.status(400).json({
      message: "Invalid slug"
    });
  }
  const room = await prisma.room.findFirst({
    where: { 
      slug 
    },
  });

  if (!room) {
    return res.status(404).json({ 
      message: "Room not found" 
    });
  }

  return res.json({ 
    room 
  });
});

const PORT = 3005;
app.listen(PORT, () => {
  console.log(`server is running on http://localhost:${PORT}`);
});