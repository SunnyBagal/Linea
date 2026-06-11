import { NextFunction } from "express";
import jwt, { type JwtPayload } from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET;

export function authMiddleware(req:Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization;
  
  if (!token) {
    return res.status(401).json({
      message: "No token provided"
    })
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    if (typeof decoded === "object" && decoded.userId) {
      req.userId = decoded.userId;
      return next();
    }
    return res.status(401).json({ msg: "Unauthorized" });

  } catch(err) {
    return res.status(401).json({ msg: "Invalid token" });
  }
};