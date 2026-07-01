import { useEffect, useState } from "react";
import { WS_URL } from "../config";

export function useSocket() {
  const [loading, setLoading] = useState(true);
  const [socket, setSocket] = useState<WebSocket>();

  useEffect(() => {

    const token = localStorage.getItem("token") ?? "";
    const ws = new WebSocket(`${WS_URL}?token=${token}`);
 
    ws.onopen = () => {
      setLoading(false);
      setSocket(ws);
    };
    
    return () => {
      ws.close();
    };
  }, []);

  return { socket, loading };
}