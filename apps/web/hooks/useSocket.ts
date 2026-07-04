import { useEffect, useRef, useState } from "react";
import { WS_URL } from "../config";

export function useSocket() {
  const [loading, setLoading] = useState(true);
  const [socket, setSocket] = useState<WebSocket>();
  const retryRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closedByUsRef = useRef(false);

  useEffect(() => {
    closedByUsRef.current = false;

    const connect = () => {
      const token = localStorage.getItem("token") ?? "";
      const ws = new WebSocket(`${WS_URL}?token=${token}`);

      ws.onopen = () => {
        retryRef.current = 0;
        setSocket(ws);
        setLoading(false);
      };

      ws.onerror = () => {
        setLoading(true);
      };

      ws.onclose = () => {
        setSocket(undefined);
        if (closedByUsRef.current) return;

        setLoading(true);
        const delay = Math.min(500 * 2 ** retryRef.current, 5000);
        retryRef.current += 1;
        timerRef.current = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      closedByUsRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
      setSocket((s) => {
        if (s && (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING)) {
          s.close();
        }
        return undefined;
      });
    };
  }, []);

  return { socket, loading };
}