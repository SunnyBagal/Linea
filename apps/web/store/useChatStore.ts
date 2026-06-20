import { create } from "zustand";

type Chat = { message: string };

interface ChatState {
  chats: Chat[];
  setChats: (chats: Chat[]) => void;      
  addChat: (chat: Chat) => void;          
}

export const useChatStore = create<ChatState>((set) => ({
  chats: [],
  setChats: (chats) => set({ chats }),
  addChat: (chat) => set((state) => ({ chats: [...state.chats, chat] })),
}));