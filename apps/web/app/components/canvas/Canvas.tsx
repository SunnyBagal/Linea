import { useEffect, useRef } from "react"

export function Cnavas({
  roomId
}: {
  roomId: string
}){
  
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (canvasRef.current) {
      initDraw(canvasRef.current, roomId)
    }
  }, [canvasRef]);

  return (
    <div>
      <canvas ref={canvasRef} width={2000} height={2000}></canvas>
    </div>
  )


} 