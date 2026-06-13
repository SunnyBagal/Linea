import express from 'express';
import argon2 from 'argon2'
import jwt from 'jsonwebtoken';
import { authMiddleware } from './middleware/middleware';
import { JWT_SECRET } from "@repo/backend-common/config"
import { CreateRoomSchema, CreateUserSchema, SigninSchema } from "@repo/common/types"

const app = express();
app.use(express.json());

app.post("/signup", async(req, res) => {
  try {
    const data = CreateUserSchema.safeParse(req.body);
    if (!data.success) {
      return res.json({
        message: "Incorrect inputs"
      })
    }
    const {username, email, password} = req.body;

    if (!username || !email || !password ) {
      return res.status(400).json({
        message: "Username, email and password are required",
      });
    }

    const hashedPassword = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 32768,
      timeCost: 3,
      parallelism: 1
    });

    const user = 0;


  } catch (err) {

  }
})


app.post("/signin", async (req, res) => {
  const data = SigninSchema.safeParse(req.body);
  if (!data.success) {
      return res.json({
        message: "Incorrect inputs"
      })
    }

    const userId = 1;

  const token = jwt.sign({
    userId
  }, JWT_SECRET);

  res.json({token})

})


app.post("/room", authMiddleware, (req, res) => {
  const data = CreateRoomSchema.safeParse(req.body);
  if (!data.success) {
      return res.json({
        message: "Incorrect inputs"
      })
  }

  res.json({
    roomId: "xyz"
  })
})


const PORT = 3005
app.listen(PORT, () => {
  console.log(`server is running on http://localhost:${PORT}`);
});

