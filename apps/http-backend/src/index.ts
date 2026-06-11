import express from 'express';
import argon2 from 'argon2'

const app = express();
app.use(express.json());

app.post("/signup", async(req, res) => {
  try {

    const {username, email, password} = req.body();

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
  
})

const PORT = 3005
app.listen(PORT, () => {
  console.log(`server is running on http://localhost:${PORT}`);
});

