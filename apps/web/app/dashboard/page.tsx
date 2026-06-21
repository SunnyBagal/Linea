"use client";
import { useEffect, useState } from "react";
import { useSocket } from "../../hooks/useSocket";

const ROOM_ID = 1;

export default function Dashboard() {
  const { socket, loading } = useSocket();
  const [messages, setMessages] = useState<string[]>([]);

  useEffect(() => {
    if (!socket || loading) return;

    socket.send(JSON.stringify({ type: 
      "join_room", roomId: ROOM_ID 
    }));

    const handler = (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      if (data.type === "chat") {
        setMessages((m) => [...m, data.message]);
      }
    };
    socket.addEventListener("message", handler);
    return () => socket.removeEventListener("message", handler);
  }, [socket, loading]);

  return (
    <div style={{ padding: 24, fontFamily: "sans-serif" }}>
      <h1>WS Test — Room {ROOM_ID}</h1>
      <p>Status: {loading ? "connecting…" : "connected ✅"}</p>
      <ul>
        {messages.map((m, i) => (
          <li key={i}>{m}</li>
        ))}
      </ul>
    </div>
  );
}