import { ChatRoomClient } from "./ChatRoomClient";

export function ChatRoom({ id }: { id: number }) {
  return <ChatRoomClient id={id} />;
}