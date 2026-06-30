import { useEffect, useState } from "react";
import { WS_URL } from "../../config";


export function RoomCanvas({ roomId }: string) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [socket, useSocket ] = useState<WebSocket | null>(null);

  useEffect(() => {
    const ws = new WebSocket(WS_URL)
    ws.onopen = () => {
      setSocket(ws);
    } 
  }, [])

  useEffect(() => {
    
    if (canvasRef.current){
      initDraw(canvasRef.current, roomId)
    }
  }, [canvasRef]);

  if (!socket) {
    return (
      <div>
        Connecting to server...
      </div>
    )
  }

  return <div>
    <Canvas roomId={roomId} />
  </div>

  
}