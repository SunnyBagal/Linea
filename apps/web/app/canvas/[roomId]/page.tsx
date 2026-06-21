import { useEffect, useRef } from "react"

export default function Canvas () {

  const canvasRef = useRef();

  useEffect(() => {

    if (canvasRef.current) {
      
    }


  }, [canvasRef]);

  return (
    <div>
      <canvas className="w-125 h-125 bg-amber-50"></canvas>
      Hi there
      
    </div>
  )
}