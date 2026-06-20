"use client";

import { useEffect, useState } from "react";
import { useSocket } from "../../hooks/useSocket";
import { useChats } from "../../hooks/useChats";
import { useChatStore } from "../../store/useChatStore";

export function ChatRoomClient({ id }: { id: number }) {
  const { socket, loading } = useSocket();
  const { data: initialChats, isPending, isError } = useChats(id);

  // Read live state + actions from the store.
  const chats = useChatStore((s) => s.chats);
  const setChats = useChatStore((s) => s.setChats);
  const addChat = useChatStore((s) => s.addChat);

  const [currentMessage, setCurrentMessage] = useState("");

  // 1. Seed the store once the initial Query load resolves.
  useEffect(() => {
    if (initialChats) setChats(initialChats);
  }, [initialChats, setChats]);

  // 2. Join the room + patch the store from live WS messages.
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
      JSON.stringify({ type: "chat", roomId: id, message: currentMessage })
    );
    // Server excludes the sender from its broadcast, so add locally.
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