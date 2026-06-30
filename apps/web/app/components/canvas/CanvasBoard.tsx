"use client";

import { useEffect, useRef } from "react";
import { Shape } from "../../../lib/canvas/types";
import { redraw, getCanvasPos, fetchShapes } from "../../../lib/canvas/canvas";
import { useSocket } from "../../../hooks/useSocket";
import axios from "axios";
import { HTTP_BACKEND } from "../../config";

export default function CanvasBoard({ roomId }: { roomId: number }, socket: WebSocket) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shapesRef = useRef<Shape[]>([]);
  const { socket, loading } = useSocket();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (!socket || loading) return;

    socket.onmessage = (event) => {
      
    }



    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      redraw(ctx, canvas, shapesRef.current);
    };
    resize();
    window.addEventListener("resize", resize);

    const loadShapes = async () => { 
      const shapes = await fetchShapes(roomId);
      shapesRef.current = shapes;
      redraw(ctx, canvas, shapesRef.current);
    };
    loadShapes();

    socket.send(JSON.stringify({ 
      type: "join_room", roomId
    }));

    const onSocketMessage = (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.type === "chat") {
        const shape: Shape = JSON.parse(data.message);
        shapesRef.current.push(shape);
        redraw(ctx, canvas, shapesRef.current);
      }
    };
    socket.addEventListener("message", onSocketMessage);

    let clicked = false;
    let startX = 0;
    let startY = 0;

    const onDown = (e: MouseEvent) => {
      clicked = true;
      const { x, y } = getCanvasPos(e, canvas);
      startX = x;
      startY = y;
    };

    const onMove = (e: MouseEvent) => {
      if (!clicked) return;
      const { x, y } = getCanvasPos(e, canvas);
      redraw(ctx, canvas, shapesRef.current);
      ctx.strokeStyle = "#111";
      ctx.lineWidth = 2;
      ctx.strokeRect(startX, startY, x - startX, y - startY);
    };

    const onUp = (e: MouseEvent) => {
    if (!clicked) return;
    clicked = false;
    const { x, y } = getCanvasPos(e, canvas);
    if (x === startX && y === startY) return;

    const newShape: Shape = {
      type: "rect",
      x: startX,
      y: startY,
      width: x - startX,
      height: y - startY,
    };

    shapesRef.current.push(newShape);
    socket.send(JSON.stringify({
      type: "chat",
      roomId,
      message: JSON.stringify(newShape),
    }));

    redraw(ctx, canvas, shapesRef.current);
    };

    canvas.addEventListener("mousedown", onDown);
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mouseup", onUp);

    return () => {
      window.removeEventListener("resize", resize);
      socket.removeEventListener("message", onSocketMessage);
      canvas.removeEventListener("mousedown", onDown);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mouseup", onUp);
    };
  }, [roomId, socket, loading]);

  // export async function getExistingShapes(canvas: HTMLCanvasElement, roomId: string) {
  //   const ctx = canvas.getContext("2d");
  //   let getExistingShapes: Shape[] = await getExistingShapes(roomId)

  //   if(!ctx) {
  //     return
  //   }

  //   const res = await axios.get(`${HTTP_BACKEND}/chats/${roomId}`)
  //   const data = res.data;

  // }


  return (
    <canvas
      ref={canvasRef}
      className="fixed left-0 top-0 block"
      style={{ background: "#fff" }}
    />
  );
}