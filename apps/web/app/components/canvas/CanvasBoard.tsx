"use client";

import { useEffect, useRef, useState } from "react";
import { Shape, Tool, Camera, ShapeGeometry } from "../../../lib/canvas/types";
import { useSocket } from "../../../hooks/useSocket";
import {
  redraw, drawShape, buildShape, getCanvasPos, fetchShapes, simplify,
  screenToWorld, MIN_SCALE, MAX_SCALE,
  getShapesBounds
} from "../../../lib/canvas/canvas";

const TOOLS: { id: Tool; glyph: string; key: string }[] = [
  { id: "rect", glyph: "▭", key: "r" },
  { id: "circle", glyph: "◯", key: "c" },
  { id: "line", glyph: "╱", key: "l" },
  { id: "arrow", glyph: "↗", key: "a" },
  { id: "pencil", glyph: "✎", key: "p" },
];

const MIN_POINT_DIST_SQ = 4;

export default function CanvasBoard({ roomId }: { roomId: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shapesRef = useRef<Shape[]>([]);
  const cameraRef = useRef<Camera>({ x: 0, y: 0, scale: 1 });
  const redrawRef = useRef<() => void>(() => {});
  const { socket, loading } = useSocket();
  const zoomToFitRef = useRef<() => void>(() => {});
  const [tool, setTool] = useState<Tool>("rect");
  const toolRef = useRef<Tool>("rect");
  const [zoomPct, setZoomPct] = useState(100);

  const selectTool = (t: Tool) => {
    setTool(t);
    toolRef.current = t;
  };

  // Zoom the camera toward the viewport center (used by the +/- buttons).
  const applyZoom = (factor: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const cam = cameraRef.current;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const world = screenToWorld(cx, cy, cam);
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cam.scale * factor));
    cam.x = cx - world.x * newScale;
    cam.y = cy - world.y * newScale;
    cam.scale = newScale;
    setZoomPct(Math.round(newScale * 100));
    redrawRef.current();
  };

  const resetZoom = () => {
    cameraRef.current = { x: 0, y: 0, scale: 1 };
    setZoomPct(100);
    redrawRef.current();
  };

  const zoomToFit = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bounds = getShapesBounds(shapesRef.current);
    if (!bounds) { resetZoom(); return; } // empty board → home

    const pad = 80; // screen-px breathing room around content
    const contentW = Math.max(1, bounds.maxX - bounds.minX);
    const contentH = Math.max(1, bounds.maxY - bounds.minY);
    const scale = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, Math.min(
        (canvas.width - pad * 2) / contentW,
        (canvas.height - pad * 2) / contentH
      ))
    );
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    cameraRef.current = {
      scale,
      x: canvas.width / 2 - cx * scale,  // center content in viewport
      y: canvas.height / 2 - cy * scale,
    };
    setZoomPct(Math.round(scale * 100));
    redrawRef.current();
  };
  zoomToFitRef.current = zoomToFit;

  useEffect(() => {
    const map: Record<string, Tool> = {
      r: "rect", c: "circle", l: "line", a: "arrow", p: "pencil",
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey && e.code === "Digit1") {
        e.preventDefault();
        zoomToFitRef.current();
        return;
      }
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

    // Lets the zoom buttons repaint without re-plumbing ctx out of the effect.
    redrawRef.current = () =>
      redraw(ctx, canvas, shapesRef.current, cameraRef.current);

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      redraw(ctx, canvas, shapesRef.current, cameraRef.current);
    };
    resize();
    window.addEventListener("resize", resize);

    const loadShapes = async () => {
      const shapes = await fetchShapes(roomId);
      shapesRef.current = shapes;
      redraw(ctx, canvas, shapesRef.current, cameraRef.current);
    };
    loadShapes();

    socket.send(JSON.stringify({ type: "join_room", roomId }));

    const onSocketMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "chat") {
          const shape: Shape = JSON.parse(data.message);
          shapesRef.current.push(shape);
          redraw(ctx, canvas, shapesRef.current, cameraRef.current);
        }
      } catch {
        // ignore malformed frames
      }
    };
    socket.addEventListener("message", onSocketMessage);

    // ---- interaction state (all in world coords except pan bookkeeping) ----
    let drawing = false;
    let startX = 0;
    let startY = 0;
    let currentPoints: { x: number; y: number }[] = [];

    let panning = false;
    let spaceHeld = false;
    let lastPanX = 0;
    let lastPanY = 0;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && !spaceHeld) {
        spaceHeld = true;
        if (!panning) canvas.style.cursor = "grab";
        e.preventDefault(); // stop page scroll
      }
    };
    
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceHeld = false;
        if (!panning) canvas.style.cursor = "crosshair";
      }
    };

    const onDown = (e: MouseEvent) => {
      // Pan: middle mouse OR space-drag.
      if (e.button === 1 || spaceHeld) {
        panning = true;
        lastPanX = e.clientX;
        lastPanY = e.clientY;
        canvas.style.cursor = "grabbing";
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return; // ignore right-click for drawing

      drawing = true;
      const { x: sx, y: sy } = getCanvasPos(e, canvas);
      const w = screenToWorld(sx, sy, cameraRef.current);
      startX = w.x;
      startY = w.y;
      if (toolRef.current === "pencil") currentPoints = [{ x: w.x, y: w.y }];
    };

    const onMove = (e: MouseEvent) => {
      if (panning) {
        const cam = cameraRef.current;
        cam.x += e.clientX - lastPanX; // pan delta is screen-space
        cam.y += e.clientY - lastPanY;
        lastPanX = e.clientX;
        lastPanY = e.clientY;
        redraw(ctx, canvas, shapesRef.current, cam);
        return;
      }
      if (!drawing) return;

      const { x: sx, y: sy } = getCanvasPos(e, canvas);
      const w = screenToWorld(sx, sy, cameraRef.current);
      const t = toolRef.current;

      if (t === "pencil") {
        const last = currentPoints[currentPoints.length - 1];
        if (!last || (w.x - last.x) ** 2 + (w.y - last.y) ** 2 >= MIN_POINT_DIST_SQ) {
          currentPoints.push({ x: w.x, y: w.y });
        }
        redraw(ctx, canvas, shapesRef.current, cameraRef.current);
        drawShape(ctx, { type: "pencil", points: currentPoints });
      } else {
        redraw(ctx, canvas, shapesRef.current, cameraRef.current);
        const preview = buildShape(t, startX, startY, w.x, w.y);
        if (preview) drawShape(ctx, preview);
      }
    };

    const onUp = (e: MouseEvent) => {
      if (panning) {
        panning = false;
        canvas.style.cursor = spaceHeld ? "grab" : "crosshair";
        return;
      }
      if (!drawing) return;
      drawing = false;

      const { x: sx, y: sy } = getCanvasPos(e, canvas);
      const w = screenToWorld(sx, sy, cameraRef.current);
      const t = toolRef.current;
      
      let geometry: ShapeGeometry | null = null;

      if (t === "pencil") {
        if (currentPoints.length < 2) {
          currentPoints = [];
          return;
        }
        geometry = { type: "pencil", points: simplify(currentPoints, 2.5) };
        currentPoints = [];
      } else {
        if (w.x === startX && w.y === startY) return;
        geometry = buildShape(t, startX, startY, w.x, w.y);
      }

      if (!geometry) return;
      // Identity assigned exactly once, here at commit.
      const shape: Shape = { ...geometry, id: crypto.randomUUID() };

      shapesRef.current.push(shape);
      socket.send(JSON.stringify({
        type: "chat",
        roomId,
        message: JSON.stringify(shape),
      }));
      redraw(ctx, canvas, shapesRef.current, cameraRef.current);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cam = cameraRef.current;

      if (e.ctrlKey || e.metaKey) {
        // Zoom toward the cursor (ctrl+wheel, or trackpad pinch).
        const { x: sx, y: sy } = getCanvasPos(e, canvas);
        const world = screenToWorld(sx, sy, cam);
        const factor = Math.exp(-e.deltaY * 0.0045);
        const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cam.scale * factor));
        cam.x = sx - world.x * newScale;
        cam.y = sy - world.y * newScale;
        cam.scale = newScale;
        setZoomPct(Math.round(newScale * 100));
      } else {
        // Plain scroll / two-finger trackpad = pan.
        cam.x -= e.deltaX;
        cam.y -= e.deltaY;
      }
      redraw(ctx, canvas, shapesRef.current, cam);
    };

    canvas.addEventListener("mousedown", onDown);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    return () => {
      window.removeEventListener("resize", resize);
      socket.removeEventListener("message", onSocketMessage);
      canvas.removeEventListener("mousedown", onDown);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
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

      <div className="fixed bottom-4 left-4 flex items-center gap-1 rounded-lg bg-[#0e1110] p-1 text-neutral-300 ring-1 ring-white/10">
        <button onClick={() => applyZoom(1 / 1.2)} className="h-7 w-7 rounded hover:bg-white/10">−</button>
        <button onClick={resetZoom} className="h-7 min-w-14 rounded text-xs hover:bg-white/10">
          {zoomPct}%
        </button>
        <button onClick={() => applyZoom(1.2)} className="h-7 w-7 rounded hover:bg-white/10">+</button>
        <button onClick={zoomToFit} className="h-7 rounded px-2 text-xs hover:bg-white/10">Fit</button>
      </div>

      {loading && (
        <div className="fixed inset-0 grid place-items-center bg-white/80 text-sm text-neutral-600">
          Connecting to server…
        </div>
      )}
    </>
  );
}