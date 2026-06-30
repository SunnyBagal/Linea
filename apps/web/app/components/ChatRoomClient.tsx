"use client";

import { useEffect, useState } from "react";
import { useSocket } from "../../hooks/useSocket";
import { useChats } from "../../hooks/useChats";
import { useChatStore } from "../../store/useChatStore";

export function ChatRoomClient({ id }: { id: number }) {
  const { socket, loading } = useSocket();
  const { data: initialChats, isPending, isError } = useChats(id);
  const chats = useChatStore((s) => s.chats);
  const setChats = useChatStore((s) => s.setChats);
  const addChat = useChatStore((s) => s.addChat);

  const [currentMessage, setCurrentMessage] = useState("");

  useEffect(() => {
    if (initialChats) setChats(initialChats);
  }, [initialChats, setChats]);

  useEffect(() => {
    if (!socket || loading) return;

    socket.send(JSON.stringify({ type: "join_room", roomId: id }));

    const handler = (event: MessageEvent) => {
      const parsed = JSON.parse(event.data);
      if (parsed.type === "chat") {
        addChat({ message: parsed.message });
      }
    };

    socket.addEventListener("message", handler);
    return () => socket.removeEventListener("message", handler);
  }, [socket, loading, id, addChat]);

  const sendMessage = () => {
    if (!socket || !currentMessage.trim()) return;
    socket.send(
      JSON.stringify({ 
        type: "chat", 
        roomId: id, 
        message: currentMessage 
      })
    );

    addChat({ message: currentMessage });
    setCurrentMessage("");
  };

  if (isPending) return <div>Loading chats…</div>;
  if (isError) return <div>Failed to load chats.</div>;

  return (
    <div>
      {chats.map((m, i) => (
        <div key={i}>{m.message}</div>
      ))}
      <input
        type="text"
        value={currentMessage}
        onChange={(e) => setCurrentMessage(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && sendMessage()}
      />
      <button onClick={sendMessage}>Send Message</button>
    </div>
  );
}