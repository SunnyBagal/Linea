"use client";

import { useEffect, useRef, useState } from "react";
import { Shape, Tool, Camera, ShapeGeometry, CanvasOp } from "../../../lib/canvas/types";
import { useSocket } from "../../../hooks/useSocket";
import {
  redraw, drawShape, buildShape, getCanvasPos, fetchOperations, simplify,
  screenToWorld, MIN_SCALE, MAX_SCALE, getShapesBounds, applyOp,
  hitTest, translateShape, stateAtSeq,setTheme, getThemeBg, type Theme,
} from "../../../lib/canvas/canvas";
import { useRouter } from "next/navigation";

const TOOLS: { id: Tool; glyph: string; key: string }[] = [
  { id: "select", glyph: "⌖", key: "v" },
  { id: "rect", glyph: "▭", key: "r" },
  { id: "circle", glyph: "◯", key: "c" },
  { id: "line", glyph: "╱", key: "l" },
  { id: "arrow", glyph: "↗", key: "a" },
  { id: "pencil", glyph: "✎", key: "p" },
];

const MIN_POINT_DIST_SQ = 4;

export default function CanvasBoard({ roomId }: { roomId: number }) {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shapesRef = useRef<Shape[]>([]);
  const cameraRef = useRef<Camera>({ x: 0, y: 0, scale: 1 });
  const selectedIdRef = useRef<string | null>(null);
  const redrawRef = useRef<() => void>(() => {});
  const { socket, loading } = useSocket();
  const zoomToFitRef = useRef<() => void>(() => {});
  const undoStackRef = useRef<CanvasOp[]>([]);

  // The in-memory op-log: ordered, seq-stamped. Hydration fills it; live ops
  // and our own acks append to it. Time-travel folds prefixes of this.
  const opLogRef = useRef<CanvasOp[]>([]);

  const [tool, setTool] = useState<Tool>("select");
  const toolRef = useRef<Tool>("select");
  const [zoomPct, setZoomPct] = useState(100);

  // Menu (Excalidraw-style hamburger). Time-travel lives inside it for now;
  // dashboard / user / theme / logout will join it later.
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setThemeState] = useState<Theme>("dark"); // fixed for SSR match

  const toggleTheme = () => setThemeState((t) => (t === "dark" ? "light" : "dark"));

  // Time-travel: state drives the slider UI, refs drive the canvas handlers.
  const [travelActive, setTravelActive] = useState(false);
  const [travelSeq, setTravelSeq] = useState(0);
  const [maxSeq, setMaxSeq] = useState(0);
  const travelActiveRef = useRef(false);
  const travelSeqRef = useRef(0);

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
    const shapes = travelActiveRef.current
      ? stateAtSeq(opLogRef.current, travelSeqRef.current)
      : shapesRef.current;
    const bounds = getShapesBounds(shapes);
    if (!bounds) { resetZoom(); return; }

    const pad = 80;
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
      x: canvas.width / 2 - cx * scale,
      y: canvas.height / 2 - cy * scale,
    };
    setZoomPct(Math.round(scale * 100));
    redrawRef.current();
  };
  zoomToFitRef.current = zoomToFit;

  // Highest seq present in the log (current head).
  const currentMaxSeq = () => {
    const log = opLogRef.current;
    let m = 0;
    for (const op of log) if (op.seq !== undefined && op.seq > m) m = op.seq;
    return m;
  };

  const enterTravel = () => {
    const max = currentMaxSeq();
    setMaxSeq(max);
    setTravelSeq(max);
    travelSeqRef.current = max;
    setTravelActive(true);
    travelActiveRef.current = true;
    selectedIdRef.current = null; // no selection in read-only past
    redrawRef.current();
  };

  const exitTravel = () => {
    setTravelActive(false);
    travelActiveRef.current = false;
    redrawRef.current(); // snap back to live head (which may include others' ops)
  };

  const onScrub = (n: number) => {
    setTravelSeq(n);
    travelSeqRef.current = n;
    redrawRef.current();
  };

  // On mount (client only), load the saved theme.
  useEffect(() => {
    const saved = localStorage.getItem("linea-theme") as Theme | null;
    if (saved && saved !== theme) setThemeState(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once

  // Apply theme to the canvas palette, persist, repaint.
  useEffect(() => {
    setTheme(theme);
    localStorage.setItem("linea-theme", theme);
    redrawRef.current();
  }, [theme]);

  useEffect(() => {
    const map: Record<string, Tool> = {
      v: "select", r: "rect", c: "circle", l: "line", a: "arrow", p: "pencil",
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.shiftKey && e.code === "Digit1") {
        e.preventDefault();
        zoomToFitRef.current();
        return;
      }
      if (travelActiveRef.current) return; // tools disabled while viewing the past
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

    // Central repaint: in travel mode, paint the folded prefix; else live shapes.
    redrawRef.current = () => {
      const shapes = travelActiveRef.current
        ? stateAtSeq(opLogRef.current, travelSeqRef.current)
        : shapesRef.current;
      // Selection highlight only in live mode.
      const sel = travelActiveRef.current ? null : selectedIdRef.current;
      redraw(ctx, canvas, shapes, cameraRef.current, sel);
    };

    const resize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      redrawRef.current();
    };
    resize();
    window.addEventListener("resize", resize);

    // Hydration buffers live ops that land during the fetch, then flushes them.
    let hydrating = true;
    const opBuffer: CanvasOp[] = [];

    const loadOps = async () => {
      const ops = await fetchOperations(roomId);
      opLogRef.current = [...ops];        // seed the in-memory log
      let shapes: Shape[] = [];
      for (const op of ops) shapes = applyOp(shapes, op);
      for (const op of opBuffer) {
        opLogRef.current.push(op);
        shapes = applyOp(shapes, op);
      }
      opBuffer.length = 0;
      shapesRef.current = shapes;
      hydrating = false;
      redrawRef.current();
    };
    loadOps();

    socket.send(JSON.stringify({ type: "join_room", roomId }));

    const onSocketMessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);

        // Ack for one of OUR ops: backfill the server-assigned seq in the log.
        if (data.type === "op_ack") {
          const entry = opLogRef.current.find(
            (o) => o.shapeId === data.shapeId && o.seq === undefined
          );
          if (entry) entry.seq = data.seq;
          return;
        }

        if (data.type === "op") {
          const op: CanvasOp = {
            opType: data.opType,
            shapeId: data.shapeId,
            payload: data.payload ?? null,
            seq: data.seq,
          };
          if (hydrating) {
            opBuffer.push(op);
            return;
          }
          // Always record in the log (so it's on the timeline)...
          opLogRef.current.push(op);
          // ...and fold into live state.
          shapesRef.current = applyOp(shapesRef.current, op);
          if (op.opType === "DELETE" && selectedIdRef.current === op.shapeId) {
            selectedIdRef.current = null;
          }
          // If we're viewing the past, don't disturb the frozen frame — the op
          // is in the log and will be there when we exit travel.
          if (!travelActiveRef.current) redrawRef.current();
        }
      } catch {
        // ignore malformed frames
      }
    };
    socket.addEventListener("message", onSocketMessage);

    // Apply locally + broadcast + record in the log (seq backfilled by ack).
    const emitOp = (op: CanvasOp) => {
      shapesRef.current = applyOp(shapesRef.current, op);
      opLogRef.current.push({ ...op, seq: undefined }); // awaiting ack
      socket.send(JSON.stringify({
        type: "op",
        roomId,
        opType: op.opType,
        shapeId: op.shapeId,
        payload: op.payload,
      }));
    };

    const doUndo = () => {
      const inverse = undoStackRef.current.pop();
      if (!inverse) return;
      selectedIdRef.current = null;
      emitOp(inverse);
      redrawRef.current();
    };

    // ---- interaction state ----
    let drawing = false;
    let startX = 0;
    let startY = 0;
    let currentPoints: { x: number; y: number }[] = [];

    let panning = false;
    let spaceHeld = false;
    let lastPanX = 0;
    let lastPanY = 0;

    let dragging = false;
    let dragStartWorld = { x: 0, y: 0 };
    let dragOrigShape: Shape | null = null;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && !spaceHeld) {
        spaceHeld = true;
        if (!panning) canvas.style.cursor = "grab";
        e.preventDefault();
        return;
      }

      if (travelActiveRef.current) return; // editing disabled in the past

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        doUndo();
        return;
      }

      if ((e.key === "Delete" || e.key === "Backspace") && selectedIdRef.current) {
        const id = selectedIdRef.current;
        const deleted = shapesRef.current.find((s) => s.id === id);
        if (!deleted) return;
        undoStackRef.current.push({ opType: "CREATE", shapeId: id, payload: deleted });
        selectedIdRef.current = null;
        emitOp({ opType: "DELETE", shapeId: id, payload: null });
        redrawRef.current();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        spaceHeld = false;
        if (!panning) canvas.style.cursor = "crosshair";
      }
    };

    const onDown = (e: MouseEvent) => {
      setMenuOpen(false);
      if (e.button === 1 || spaceHeld) {
        panning = true;
        lastPanX = e.clientX;
        lastPanY = e.clientY;
        canvas.style.cursor = "grabbing";
        e.preventDefault();
        return;
      }
      if (e.button !== 0) return;
      
      if (travelActiveRef.current) return;

      const { x: sx, y: sy } = getCanvasPos(e, canvas);
      const w = screenToWorld(sx, sy, cameraRef.current);

      if (toolRef.current === "select") {
        const tol = 8 / cameraRef.current.scale;
        const hit = hitTest(shapesRef.current, w.x, w.y, tol);
        selectedIdRef.current = hit ? hit.id : null;
        if (hit) {
          dragging = true;
          dragStartWorld = { x: w.x, y: w.y };
          dragOrigShape = hit;
        }
        redrawRef.current();
        return;
      }

      drawing = true;
      startX = w.x;
      startY = w.y;
      if (toolRef.current === "pencil") currentPoints = [{ x: w.x, y: w.y }];
    };

    const onMove = (e: MouseEvent) => {
      if (dragging && dragOrigShape) {
        const { x: sx, y: sy } = getCanvasPos(e, canvas);
        const w = screenToWorld(sx, sy, cameraRef.current);
        const dx = w.x - dragStartWorld.x;
        const dy = w.y - dragStartWorld.y;
        const moved = translateShape(dragOrigShape, dx, dy);
        shapesRef.current = shapesRef.current.map((s) => (s.id === moved.id ? moved : s));
        redrawRef.current();
        return;
      }

      if (panning) {
        const cam = cameraRef.current;
        cam.x += e.clientX - lastPanX;
        cam.y += e.clientY - lastPanY;
        lastPanX = e.clientX;
        lastPanY = e.clientY;
        redrawRef.current();
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
        redrawRef.current();
        drawShape(ctx, { type: "pencil", points: currentPoints });
      } else {
        redrawRef.current();
        const preview = buildShape(t, startX, startY, w.x, w.y);
        if (preview) drawShape(ctx, preview);
      }
    };

    const onUp = (e: MouseEvent) => {
      if (dragging && dragOrigShape) {
        dragging = false;
        const { x: sx, y: sy } = getCanvasPos(e, canvas);
        const w = screenToWorld(sx, sy, cameraRef.current);
        const dx = w.x - dragStartWorld.x;
        const dy = w.y - dragStartWorld.y;
        const orig = dragOrigShape;
        dragOrigShape = null;
        if (dx === 0 && dy === 0) return;

        const moved = translateShape(orig, dx, dy);
        if (!moved.id){
          console.warn(
            "drag: shape has no id, skipping Update", moved
          );
          return
        }
        undoStackRef.current.push({ opType: "UPDATE", shapeId: orig.id, payload: orig });
        // Local state already reflects `moved`; record in log + broadcast.
        opLogRef.current.push({ opType: "UPDATE", shapeId: moved.id, payload: moved, seq: undefined });
        socket.send(JSON.stringify({
          type: "op",
          roomId,
          opType: "UPDATE",
          shapeId: moved.id,
          payload: moved,
        }));
        return;
      }

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
        if (currentPoints.length < 2) { currentPoints = []; return; }
        geometry = { type: "pencil", points: simplify(currentPoints, 2.5) };
        currentPoints = [];
      } else {
        if (w.x === startX && w.y === startY) return;
        geometry = buildShape(t, startX, startY, w.x, w.y);
      }

      if (!geometry) return;

      const shape: Shape = { ...geometry, id: crypto.randomUUID() };
      undoStackRef.current.push({ opType: "DELETE", shapeId: shape.id, payload: null });
      emitOp({ opType: "CREATE", shapeId: shape.id, payload: shape });
      redrawRef.current();
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cam = cameraRef.current;
      if (e.ctrlKey || e.metaKey) {
        const { x: sx, y: sy } = getCanvasPos(e, canvas);
        const world = screenToWorld(sx, sy, cam);
        const factor = Math.exp(-e.deltaY * 0.0045);
        const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cam.scale * factor));
        cam.x = sx - world.x * newScale;
        cam.y = sy - world.y * newScale;
        cam.scale = newScale;
        setZoomPct(Math.round(newScale * 100));
      } else {
        cam.x -= e.deltaX;
        cam.y -= e.deltaY;
      }
      redrawRef.current();
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
        style={{ background: getThemeBg(theme) }}
      />

      <button
        onClick={() => setMenuOpen((v) => !v)}
        title="Menu"
        className="fixed left-4 top-4 flex h-9 w-9 items-center justify-center rounded-lg bg-[#0e1110] text-lg leading-none text-neutral-200 shadow-lg ring-1 ring-white/10 hover:bg-white/10"
      >
        ☰
      </button>

      {menuOpen && (
        <div className="fixed left-4 top-16 w-64 rounded-xl bg-[#0e1110] p-3 text-neutral-200 shadow-xl ring-1 ring-white/10">

          <div className="flex items-center justify-between">
            <span className="text-sm">Time travel</span>
            <button
              onClick={() => (travelActive ? exitTravel() : enterTravel())}
              className={`h-6 rounded px-2 text-xs transition ${
                travelActive ? "bg-[#a6ff5e] text-black" : "bg-white/10 hover:bg-white/20"
              }`}
            >
              {travelActive ? "On" : "Off"}
            </button>
          </div>

          {travelActive && (
            <div className="mt-3">
              <input
                type="range"
                min={0}
                max={maxSeq}
                value={travelSeq}
                onChange={(e) => onScrub(Number(e.target.value))}
                className="w-full accent-[#a6ff5e]"
              />
              <div className="mt-1 flex justify-between text-[11px] text-neutral-400">
                <span>empty</span>
                <span>seq {travelSeq} / {maxSeq}</span>
                <span>now</span>
              </div>
            </div>
          )}

          {/* Placeholders — wired in the dashboard/theme step */}
          <div className="mt-3 space-y-1 border-t border-white/10 pt-3 text-sm text-neutral-500">
                      
            <button
              onClick={() => router.push("/dashboard")}
              className="block w-full text-left text-neutral-200 hover:text-white"
            >
              Dashboard
            </button>
            <button
              onClick={toggleTheme}
              className="flex w-full items-center justify-between text-left text-neutral-200 hover:text-white"
            >
              <span>Theme</span>
              <span className="rounded bg-white/10 px-2 py-0.5 text-xs">
                {theme === "dark" ? "Dark" : "Light"}
              </span>
            </button>
            <button
              onClick={() => {
                localStorage.removeItem("token");
                router.push("/signin");
              }}
              className="block w-full text-left text-neutral-400 hover:text-white"
            >
              Log out
            </button>
          </div>
        </div>
      )}

      {!travelActive && (
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
      )}

      {travelActive && (
        <div className="fixed left-1/2 top-4 -translate-x-1/2 rounded-xl bg-[#a6ff5e] px-3 py-2 text-sm font-medium text-black shadow-lg">
          Viewing history — read only
        </div>
      )}

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