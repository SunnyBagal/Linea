"use client";

import { useEffect, useRef, useState } from "react";
import { Shape, Tool } from "../../../lib/canvas/types";
import { redraw, drawShape, buildShape, getCanvasPos, fetchShapes } from "../../../lib/canvas/canvas";
import { useSocket } from "../../../hooks/useSocket";

const TOOLS: { id: Tool; glyph: string; key: string }[] = [
  { id: "rect", glyph: "▭", key: "r" },
  { id: "circle", glyph: "◯", key: "c" },
  { id: "line", glyph: "╱", key: "l" },
  { id: "arrow", glyph: "↗", key: "a" },
  { id: "pencil", glyph: "✎", key: "p" },
];

export default function CanvasBoard({ roomId }: { roomId: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shapesRef = useRef<Shape[]>([]);
  const { socket, loading } = useSocket();
  const [tool, setTool] = useState<Tool>("rect");
  const toolRef = useRef<Tool>("rect");

  const selectTool = (t: Tool) => {
    setTool(t);
    toolRef.current = t;
  };

  useEffect(() => {
    const map: Record<string, Tool> = {
      r: "rect", c: "circle", l: "line", a: "arrow", p: "pencil",
    };
    const onKey = (e: KeyboardEvent) => {
      const t = map[e.key.toLowerCase()];
      if (t) selectTool(t);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (!socket || loading) return;

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

    socket.send(JSON.stringify({ type: "join_room", roomId }));

    const onSocketMessage = (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.type === "chat") {
        const shape: Shape = JSON.parse(data.message);
        shapesRef.current.push(shape);
        redraw(ctx, canvas, shapesRef.current);
      }
    };
    socket.addEventListener("message", onSocketMessage);

    let drawing = false;
    let startX = 0;
    let startY = 0;
    let currentPoints: { x: number; y: number }[] = [];

    const onDown = (e: MouseEvent) => {
      drawing = true;
      const { x, y } = getCanvasPos(e, canvas);
      startX = x;
      startY = y;
      if (toolRef.current === "pencil") currentPoints = [{ x, y }];
    };

    const onMove = (e: MouseEvent) => {
      if (!drawing) return;
      const { x, y } = getCanvasPos(e, canvas);
      const t = toolRef.current;

      redraw(ctx, canvas, shapesRef.current); 

      if (t === "pencil") {
        currentPoints.push({ x, y });
        drawShape(ctx, { type: "pencil", points: currentPoints });
      } else {
        const preview = buildShape(t, startX, startY, x, y);
        if (preview) drawShape(ctx, preview);
      }
    };

    const onUp = (e: MouseEvent) => {
      if (!drawing) return;
      drawing = false;
      const { x, y } = getCanvasPos(e, canvas);
      const t = toolRef.current;

      let shape: Shape | null = null;

      if (t === "pencil") {
        if (currentPoints.length < 2) {
          currentPoints = [];
          return;
        }
        shape = { type: "pencil", points: currentPoints };
        currentPoints = [];
      } else {
        if (x === startX && y === startY) return; 
        shape = buildShape(t, startX, startY, x, y);
      }

      if (!shape) return;

      shapesRef.current.push(shape);
      socket.send(JSON.stringify({
        type: "chat",
        roomId,
        message: JSON.stringify(shape),
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

  return (
    <>
      <canvas
        ref={canvasRef}
        className="fixed left-0 top-0 block cursor-crosshair"
        style={{ background: "#fff" }}
      />

      <div className="fixed left-1/2 top-4 -translate-x-1/2 flex gap-1 rounded-xl bg-[#0e1110] p-1 shadow-lg ring-1 ring-white/10">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            onClick={() => selectTool(t.id)}
            title={`${t.id} (${t.key})`}
            className={`h-9 w-9 rounded-lg text-lg leading-none transition ${
              tool === t.id
                ? "bg-[#a6ff5e] text-black"
                : "text-neutral-300 hover:bg-white/10"
            }`}
          >
            {t.glyph}
          </button>
        ))}
      </div>

      {loading && (
        <div className="fixed inset-0 grid place-items-center bg-white/80 text-sm text-neutral-600">
          Connecting to server…
        </div>
      )}
    </>
  );
}