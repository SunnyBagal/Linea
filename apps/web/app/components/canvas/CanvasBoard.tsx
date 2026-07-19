"use client";

import { useEffect, useRef, useState } from "react";
import { Shape, Tool, Camera, ShapeGeometry, CanvasOp } from "../../../lib/canvas/types";
import { useSocket } from "../../../hooks/useSocket";
import {
  redraw, drawShape, buildShape, getCanvasPos, fetchOperations, simplify,
  screenToWorld, MIN_SCALE, MAX_SCALE, getShapesBounds, applyOp, foldOps,
  hitTest, translateShape, stateAtSeq,setTheme, getThemeBg, type Theme,
} from "../../../lib/canvas/canvas";
import { useRouter } from "next/navigation";
import { BACKEND_URL } from "../../../config";

const TOOLS: { id: Tool; glyph: string; key: string }[] = [
  { id: "select", glyph: "↖", key: "v" },
  { id: "rect", glyph: "▭", key: "r" },
  { id: "circle", glyph: "◯", key: "c" },
  { id: "line", glyph: "╱", key: "l" },
  { id: "arrow", glyph: "↗", key: "a" },
  { id: "pencil", glyph: "✎", key: "p" },
  { id: "text", glyph: "T", key: "t"},
];

const MIN_POINT_DIST_SQ = 4;

export default function CanvasBoard({ slug }: { slug: string }) {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shapesRef = useRef<Shape[]>([]);
  const cameraRef = useRef<Camera>({ x: 0, y: 0, scale: 1 });
  const selectedIdRef = useRef<string | null>(null);
  const redrawRef = useRef<() => void>(() => {});
  const { socket, loading } = useSocket();
  const zoomToFitRef = useRef<() => void>(() => {});
  const undoStackRef = useRef<CanvasOp[]>([]);
  const [roomId, setRoomId] = useState<number | null>(null);
  const [roomError, setRoomError] = useState(false);
  const opLogRef = useRef<CanvasOp[]>([]);
  const [tool, setTool] = useState<Tool>("select");
  const toolRef = useRef<Tool>("select");
  const [zoomPct, setZoomPct] = useState(100);
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setThemeState] = useState<Theme>("dark"); 
  const toggleTheme = () => setThemeState((t) => (t === "dark" ? "light" : "dark"));
  const [travelActive, setTravelActive] = useState(false);
  const [travelSeq, setTravelSeq] = useState(0);
  const [maxSeq, setMaxSeq] = useState(0);
  const travelActiveRef = useRef(false);
  const travelSeqRef = useRef(0);
  const [textEditor, setTextEditor] = useState<{ sx: number; sy: number; wx: number; wy: number } | null>(null);
  const [textValue, setTextValue] = useState("");
  const textValueRef = useRef("");
  textValueRef.current = textValue;
  const textEditorRef = useRef<typeof textEditor>(null);
  textEditorRef.current = textEditor;

  const selectTool = (t: Tool) => {
    if (textEditorRef.current){
      commitText();
    }
    setTool(t);
    toolRef.current = t;

    if ( t !== "select"){
      selectedIdRef.current = null;
      redrawRef.current();
    }

  };

  const emitTextRef = useRef<(shape: Shape) => void>(() => {});

  const commitText = () => {
    const ed = textEditorRef.current;
    const value = textValueRef.current.trim();
    setTextEditor(null);
    setTextValue("");
    if (!ed || value.length === 0) return;
    setTextValue("");

    const shape: Shape = {
      id: crypto.randomUUID(),
      type: "text",
      x: ed.wx,
      y: ed.wy,
      text: value,
      fontSize: 24,
    };
    console.log("commitText emitting: ", shape, "emitFn: ", emitTextRef.current.toString().slice(0, 40));
    emitTextRef.current(shape);
  };

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
    if (!bounds) { 
      resetZoom(); return; 
    }

    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.width / dpr;   
    const cssH = canvas.height / dpr;

    const pad = 80;
    const contentW = Math.max(1, bounds.maxX - bounds.minX);
    const contentH = Math.max(1, bounds.maxY - bounds.minY);
    const scale = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, Math.min(
        (cssW - pad * 2) / contentW,
        (cssH - pad * 2) / contentH
      ))
    );
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    cameraRef.current = {
      scale,
      x: cssW / 2 - cx * scale,   
      y: cssH / 2 - cy * scale,
    };
    setZoomPct(Math.round(scale * 100));
    redrawRef.current();
  };

  zoomToFitRef.current = zoomToFit;

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
    selectedIdRef.current = null; 
    redrawRef.current();
  };

  const exitTravel = () => {
    setTravelActive(false);
    travelActiveRef.current = false;
    redrawRef.current(); 
  };

  const onScrub = (n: number) => {
    setTravelSeq(n);
    travelSeqRef.current = n;
    redrawRef.current();
  };


  useEffect(() => {
    const token = localStorage.getItem("token") ?? "";
    fetch(`${BACKEND_URL}/room/${slug}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (res.status === 401) { 
          localStorage.removeItem("token"); router.push("/signin"); return null; 
        }
        if (!res.ok) { 
          setRoomError(true); return null; 
        }
        return res.json();
      })
      .then((data) => {
        if (data?.room?.id) setRoomId(data.room.id);
        else if (data !== null) setRoomError(true);
      })
      .catch(() => setRoomError(true));

  }, [slug, router]);

  


  useEffect(() => {
    const saved = localStorage.getItem("linea-theme") as Theme | null;
    if (saved && saved !== theme) setThemeState(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); 

  useEffect(() => {
    setTheme(theme);
    localStorage.setItem("linea-theme", theme);
    redrawRef.current();
  }, [theme]);

  useEffect(() => {
    const map: Record<string, Tool> = {
      v: "select", r: "rect", c: "circle", l: "line", a: "arrow", p: "pencil", t: "text",
    };
    const onKey = (e: KeyboardEvent) => {
      if (textEditorRef.current) return;
      if (e.shiftKey && e.code === "Digit1") {
        e.preventDefault();
        zoomToFitRef.current();
        return;
      }
      if (travelActiveRef.current) return; 
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
    if (roomId == null ) return;

    redrawRef.current = () => {
      const shapes = travelActiveRef.current
        ? stateAtSeq(opLogRef.current, travelSeqRef.current)
        : shapesRef.current;
      const sel = travelActiveRef.current ? null : selectedIdRef.current;
      redraw(ctx, canvas, shapes, cameraRef.current, sel);
    };

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = window.innerWidth * dpr;   
      canvas.height = window.innerHeight * dpr;
      canvas.style.width = window.innerWidth + "px";
      canvas.style.height = window.innerHeight + "px";
      redrawRef.current();
    };
    resize();
    window.addEventListener("resize", resize);

    let hydrating = true;
    const opBuffer: CanvasOp[] = [];

    const loadOps = async () => {
      const ops = await fetchOperations(roomId);
      opLogRef.current = [...ops];        
      let shapes: Shape[] = foldOps(ops); // O(n) batch replay of the fetched log
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

          opLogRef.current.push(op);
          shapesRef.current = applyOp(shapesRef.current, op);
          if (op.opType === "DELETE" && selectedIdRef.current === op.shapeId) {
            selectedIdRef.current = null;
          }

          if (!travelActiveRef.current) redrawRef.current();
        }
      } catch {
        // ignore malformed frames
      }
    };
    socket.addEventListener("message", onSocketMessage);

    const emitOp = (op: CanvasOp) => {
      shapesRef.current = applyOp(shapesRef.current, op);
      opLogRef.current.push({ ...op, seq: undefined }); 
      socket.send(JSON.stringify({
        type: "op",
        roomId,
        opType: op.opType,
        shapeId: op.shapeId,
        payload: op.payload,
      }));
    };

    emitTextRef.current = (shape: Shape) => {
      undoStackRef.current.push({ opType: "DELETE", shapeId: shape.id, payload: null });
      emitOp({ opType: "CREATE", shapeId: shape.id, payload: shape });
      redrawRef.current();
    };

    const doUndo = () => {
      const inverse = undoStackRef.current.pop();
      if (!inverse) return;
      selectedIdRef.current = null;
      emitOp(inverse);
      redrawRef.current();
    };

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
      if (textEditorRef.current) return;

      if (e.code === "Space" && !spaceHeld) {
        spaceHeld = true;
        if (!panning) canvas.style.cursor = "grab";
        e.preventDefault();
        return;
      }

      if (travelActiveRef.current) return; 

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
        if (!panning) canvas.style.cursor = toolRef.current === "select" ? "default" : "crosshair";
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

      if (toolRef.current === "text") {
        e.preventDefault();
        console.log("TEXT branch hit, opening editor at, ", sx, sy);
        if (textEditorRef.current){
          commitText();
          return
        }
        const rect = canvas.getBoundingClientRect();
        setTextValue("");
        setTextEditor({
          sx: sx + rect.left,   
          sy: sy + rect.top,
          wx: w.x,              
          wy: w.y,
        });
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
        canvas.style.cursor = spaceHeld ? "grab" : toolRef.current === "select" ? "default" : "crosshair";
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
        const factor = Math.exp(-e.deltaY * 0.0025);
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

  if (roomError) {
    return (
      <div className="fixed inset-0 grid place-items-center bg-[#0b0d0c] text-neutral-300">
        <div className="text-center">
          <p className="text-lg">Canvas not found</p>
          <button onClick={() => router.push("/dashboard")} className="mt-3 text-[#a6ff5e] hover:underline">
            Back to dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <canvas
        ref={canvasRef}
        className={`fixed left-0 top-0 block ${
          tool === "select" ? "cursor-default" : "cursor-crosshair"
        }`}
        style={{ background: getThemeBg(theme) }}
      />

      {textEditor && (
        <input
          autoFocus
          value={textValue}
          onChange={(e) => setTextValue(e.target.value)}
          onBlur={() => { console.log("INPUT onBlur fired"); commitText(); }}
          onKeyDown={(e) => {
            console.log("INPUT onKeyDown:", e.key);
            if (e.key === "Enter") { e.preventDefault(); commitText(); }
            if (e.key === "Escape") { setTextEditor(null); setTextValue(""); }
          }}
          style={{
            position: "fixed",
            left: textEditor.sx,
            top: textEditor.sy,
            font: `${24 * cameraRef.current.scale}px 'Comic Sans MS', cursive`,
            color: theme === "dark" ? "#e6e6e6" : "#111",
            background: "transparent",
            border: "1px dashed #a6ff5e",
            outline: "none",
            padding: "2px 4px",
            minWidth: 40,
            zIndex: 50,
          }}
        />
      )}

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