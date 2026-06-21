"use client";

import { useEffect, useRef } from "react";

type Shape = {
  type: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
} | {
  type: "circle";
  centerX: number;
  centerY: number;
  radius: number;
}

export default function Canvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  let existingShapes: Shape[] = [];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = 500;
    canvas.height = 500;

    let clicked = false;
    let startX = 0;
    let startY = 0;

    ctx.fillStyle = "rgba(0, 0, 0)"

    const getPos = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const onDown = (e: MouseEvent) => {
      clicked = true;
      const { x, y } = getPos(e);
      startX = x;
      startY = y;
    };

    const onUp = () => {
      clicked = false;
      const width = x - startX;
      const height = y - startY;
      existingShapes.push({
        type: "rect",
        x: startX,
        y: startY,
        height, 
        width
      })

    };

    const onMove = (e: MouseEvent) => {
      if (!clicked) return;
      const { x, y } = getPos(e);
      const width = x - startX;
      const height = y - startY;

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.strokeRect(startX, startY, width, height);
    };

    canvas.addEventListener("mousedown", onDown);
    canvas.addEventListener("mouseup", onUp);
    canvas.addEventListener("mousemove", onMove);

    return () => {
      canvas.removeEventListener("mousedown", onDown);
      canvas.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("mousemove", onMove);
    };
  }, []);


  function clearCanvas

  return (
    <div>
      <canvas ref={canvasRef} className="bg-amber-50" />
      Hi there
    </div>
  );
}