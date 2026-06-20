import { useQuery } from "@tanstack/react-query";
import axios from "axios";
import { BACKEND_URL } from "../config";

async function fetchChats(roomId: number): Promise<{ message: string }[]> {
  const res = await axios.get(`${BACKEND_URL}/chats/${roomId}`);
  return res.data.messages;
}

export function useChats(roomId: number) {
  return useQuery({
    queryKey: ["chats", roomId],
    queryFn: () => fetchChats(roomId),
  });
}