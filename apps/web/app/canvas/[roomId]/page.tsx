"use client";

import { useEffect, useRef } from "react";

export default function Canvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let clicked = false;
    let startX = 0;
    let startY = 0;

    canvas.addEventListener("mousedown", (e) => {
      clicked = true;
      startX = (e.clientX)
      startY = (e.clientY)
    })

     canvas.addEventListener("mouseup", (e) => {
      clicked = false
      console.log(e.clientX)
      console.log(e.clientY)
    })

     canvas.addEventListener("mousemove", (e) => {
       if (clicked){
          const width = e.clientX - e.clientY
          const height = e.clientY - e.clientX

          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.strokeRect(startX,startY, width, height)
       }
    })

    ctx.strokeRect(20, 20, 50, 100);


  }, []);

  return (
    <div>
      <canvas ref={canvasRef} className="bg-amber-50 w-125 h-125" />
      Hi there
    </div>
  );
}