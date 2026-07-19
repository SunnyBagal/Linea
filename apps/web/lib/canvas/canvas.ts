import { Shape, ShapeGeometry, Tool, Camera, CanvasOp, OpType } from "./types";
import { BACKEND_URL } from "../../config";
import rough from "roughjs";
import type { RoughCanvas } from "roughjs/bin/canvas";
import type { Drawable } from "roughjs/bin/core";

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8;
const GRID_SIZE = 40;
const FONT_FAMILY = "'Comic Sans MS', 'Segoe Print', cursive";

export type Theme = "light" | "dark";

type Palette = { stroke: string; grid: string; bg: string };

const PALETTES: Record<Theme, Palette> = {
  light: { stroke: "#111111", grid: "rgba(0,0,0,0.06)",  bg: "#ffffff" },
  dark:  { stroke: "#e6e6e6", grid: "rgba(255,255,255,0.07)", bg: "#0b0d0c" },
};

let activePalette: Palette = PALETTES.dark;

export function setTheme(theme: Theme) {
  activePalette = PALETTES[theme];
}

export function getThemeBg(theme: Theme): string {
  return PALETTES[theme].bg;
}

export function getDpr(): number {
  return typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
}

export function screenToWorld(sx: number, sy: number, cam: Camera) {
  return { x: (sx - cam.x) / cam.scale, y: (sy - cam.y) / cam.scale };
}

export function getCanvasPos(e: MouseEvent, canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function seedFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function shapeKey(shape: Shape, stroke: string): string {
  return stroke + "|" + JSON.stringify(shape);
}

const roughCache = new Map<string, Drawable>();
const ROUGH_CACHE_MAX = 2000;

function getRough(canvas: HTMLCanvasElement): RoughCanvas {
  const anyCanvas = canvas as HTMLCanvasElement & { __rc?: RoughCanvas };
  if (!anyCanvas.__rc) anyCanvas.__rc = rough.canvas(canvas);
  return anyCanvas.__rc;
}

function getDrawable(rc: RoughCanvas, shape: Shape, stroke: string): Drawable {
  if (shape.type === "text") {
    throw new Error("getDrawable called with text shape");
  }

  const key = shapeKey(shape, stroke);
  const hit = roughCache.get(key);
  if (hit) return hit;

  const gen = rc.generator;
  const seed = seedFromId(shape.id);
  const opts = { stroke, strokeWidth: 1.6, roughness: 1.1, bowing: 1, seed };

  let d: Drawable;
  if (shape.type === "rect") {
    d = gen.rectangle(shape.x, shape.y, shape.width, shape.height, opts);
  } else if (shape.type === "circle") {
    d = gen.circle(shape.centerX, shape.centerY, shape.radius * 2, opts);
  } else if (shape.type === "line") {
    d = gen.line(shape.x1, shape.y1, shape.x2, shape.y2, opts);
  } else if (shape.type === "arrow") {
    const angle = Math.atan2(shape.y2 - shape.y1, shape.x2 - shape.x1);
    const head = 14;
    const hx1 = shape.x2 - head * Math.cos(angle - Math.PI / 6);
    const hy1 = shape.y2 - head * Math.sin(angle - Math.PI / 6);
    const hx2 = shape.x2 - head * Math.cos(angle + Math.PI / 6);
    const hy2 = shape.y2 - head * Math.sin(angle + Math.PI / 6);
    d = gen.linearPath(
      [
        [shape.x1, shape.y1],
        [shape.x2, shape.y2],
        [hx1, hy1],
        [shape.x2, shape.y2],
        [hx2, hy2],
      ],
      opts
    );
  } else {
    d = gen.linearPath(shape.points.map((p) => [p.x, p.y] as [number, number]), opts);
  }

  if (roughCache.size >= ROUGH_CACHE_MAX) {
    const keys = Array.from(roughCache.keys()).slice(0, ROUGH_CACHE_MAX / 2);
    for (const k of keys) roughCache.delete(k);
  }
  roughCache.set(key, d);
  return d;
}

export function drawShapeRough(
  rc: RoughCanvas,
  ctx: CanvasRenderingContext2D,
  shape: Shape,
  stroke: string
) {
  if (shape.type === "text") {
    ctx.save();
    ctx.fillStyle = stroke;
    ctx.font = `${shape.fontSize}px ${FONT_FAMILY}`;
    ctx.textBaseline = "top";
    ctx.fillText(shape.text, shape.x, shape.y);
    ctx.restore();
    return;
  }
  rc.draw(getDrawable(rc, shape, stroke));
}

export function drawShape(ctx: CanvasRenderingContext2D, shape: ShapeGeometry) {
  ctx.strokeStyle = activePalette.stroke;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  if (shape.type === "rect") {
    ctx.strokeRect(shape.x, shape.y, shape.width, shape.height);
  }

  else if (shape.type === "circle") {
    ctx.beginPath();
    ctx.arc(shape.centerX, shape.centerY, shape.radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  else if (shape.type === "line") {
    ctx.beginPath();
    ctx.moveTo(shape.x1, shape.y1);
    ctx.lineTo(shape.x2, shape.y2);
    ctx.stroke();
  }

  else if (shape.type === "arrow") {
    ctx.beginPath();
    ctx.moveTo(shape.x1, shape.y1);
    ctx.lineTo(shape.x2, shape.y2);
    ctx.stroke();

    const angle = Math.atan2(shape.y2 - shape.y1, shape.x2 - shape.x1);
    const head = 12;

    ctx.beginPath();
    ctx.moveTo(shape.x2, shape.y2);

    ctx.lineTo(
      shape.x2 - head * Math.cos(angle - Math.PI / 6),
      shape.y2 - head * Math.sin(angle - Math.PI / 6)
    );

    ctx.moveTo(shape.x2, shape.y2);
    ctx.lineTo(
      shape.x2 - head * Math.cos(angle + Math.PI / 6),
      shape.y2 - head * Math.sin(angle + Math.PI / 6)
    );

    ctx.stroke();
  }

  else if (shape.type === "pencil") {
    ctx.beginPath();
    shape.points.forEach((p, i) =>
      i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)
    );
    ctx.stroke();
  }
}

export function redraw(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  shapes: Shape[],
  cam: Camera,
  selectedId?: string | null
) {
  const dpr = getDpr();
  const rc = getRough(canvas);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(cam.scale * dpr, 0, 0, cam.scale * dpr, cam.x * dpr, cam.y * dpr);

  drawGrid(ctx, canvas, cam);

  const stroke = activePalette.stroke;
  for (const shape of shapes) drawShapeRough(rc, ctx, shape, stroke);

  if (selectedId) {
    const sel = shapes.find((s) => s.id === selectedId);
    if (sel) drawSelection(ctx, sel, cam.scale);
  }
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  cam: Camera
) {
  const dpr = getDpr();
  const cssW = canvas.width / dpr;
  const cssH = canvas.height / dpr;

  const left = -cam.x / cam.scale;
  const top = -cam.y / cam.scale;
  const right = (cssW - cam.x) / cam.scale;
  const bottom = (cssH - cam.y) / cam.scale;

  let step = GRID_SIZE;
  while ((right - left) / step > 80) step *= 2;

  const startX = Math.floor(left / step) * step;
  const startY = Math.floor(top / step) * step;

  ctx.strokeStyle = activePalette.grid;
  ctx.lineWidth = 1 / cam.scale;
  ctx.beginPath();
  for (let x = startX; x <= right; x += step) {
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
  }
  for (let y = startY; y <= bottom; y += step) {
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
  }
  ctx.stroke();
}

export function buildShape(
  tool: Tool,
  sx: number,
  sy: number,
  x: number,
  y: number
): ShapeGeometry | null {

  if (tool === "rect") {
    return { type: "rect", x: sx, y: sy, width: x - sx, height: y - sy };
  }

  if (tool === "circle") {
    const centerX = (sx + x) / 2;
    const centerY = (sy + y) / 2;
    const radius = Math.hypot(x - sx, y - sy) / 2;

    return { type: "circle", centerX, centerY, radius };
  }

  if (tool === "line") {
    return { type: "line", x1: sx, y1: sy, x2: x, y2: y };
  }

  if (tool === "arrow") {
    return { type: "arrow", x1: sx, y1: sy, x2: x, y2: y };
  }

  return null;
}


type Pt = { x: number; y: number };

function perpDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (dx === 0 && dy === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy);
  const cx = a.x + t * dx, cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

export function simplify(points: Pt[], epsilon = 1): Pt[] {
  if (points.length <= 2) return points;
  const start = points[0]!;
  const end = points[points.length - 1]!;

  let maxDist = 0, index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i]!, start, end);
    if (d > maxDist) { maxDist = d; index = i; }
  }

  if (maxDist > epsilon) {
    const left = simplify(points.slice(0, index + 1), epsilon);
    const right = simplify(points.slice(index), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [start, end];
}

export function getShapesBounds(shapes: Shape[]) {
  if (shapes.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const expand = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const s of shapes) {

    if (s.type === "rect") {
      expand(s.x, s.y);
      expand(s.x + s.width, s.y + s.height);
    } else if (s.type === "circle") {
      expand(s.centerX - s.radius, s.centerY - s.radius);
      expand(s.centerX + s.radius, s.centerY + s.radius);
    } else if (s.type === "line" || s.type === "arrow") {
      expand(s.x1, s.y1);
      expand(s.x2, s.y2);
    } else if (s.type === "pencil") {
      for (const p of s.points) expand(p.x, p.y);
    } else if (s.type === "text") {
      const w = s.text.length * s.fontSize * 0.6;
      expand(s.x, s.y);
      expand(s.x + w, s.y + s.fontSize);
    }
  }
  return { minX, minY, maxX, maxY };
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) {
    return Math.hypot(px - ax, py - ay);
  }

  let t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function hitShape(shape: Shape, wx: number, wy: number, tol: number): boolean {
  if (shape.type === "rect") {
    const x1 = Math.min(shape.x, shape.x + shape.width);
    const x2 = Math.max(shape.x, shape.x + shape.width);
    const y1 = Math.min(shape.y, shape.y + shape.height);
    const y2 = Math.max(shape.y, shape.y + shape.height);
    return wx >= x1 - tol && wx <= x2 + tol && wy >= y1 - tol && wy <= y2 + tol;
  }
  if (shape.type === "text") {
    const w = shape.text.length * shape.fontSize * 0.6;
    const h = shape.fontSize;
    return wx >= shape.x - tol && wx <= shape.x + w + tol &&
           wy >= shape.y - tol && wy <= shape.y + h + tol;
  }
  if (shape.type === "circle") {
    const d = Math.hypot(wx - shape.centerX, wy - shape.centerY);
    return d <= shape.radius + tol;
  }
  if (shape.type === "line" || shape.type === "arrow") {
    return distToSegment(wx, wy, shape.x1, shape.y1, shape.x2, shape.y2) <= tol;
  }
  if (shape.type === "pencil") {
    for (let i = 0; i < shape.points.length - 1; i++) {
      const a = shape.points[i]!, b = shape.points[i + 1]!;
      if (distToSegment(wx, wy, a.x, a.y, b.x, b.y) <= tol) return true;
    }
    return false;
  }
  return false;
}

export function hitTest(shapes: Shape[], wx: number, wy: number, tol: number): Shape | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    if (hitShape(shapes[i]!, wx, wy, tol)) {
      return shapes[i]!;
    }
  }
  return null;
}

export function translateShape(shape: Shape, dx: number, dy: number): Shape {
  if (shape.type === "text") {
    return { ...shape, x: shape.x + dx, y: shape.y + dy };
  }
  if (shape.type === "rect") {
    return { ...shape, x: shape.x + dx, y: shape.y + dy };
  }
  if (shape.type === "circle") {
    return { ...shape, centerX: shape.centerX + dx, centerY: shape.centerY + dy };
  }
  if (shape.type === "line" || shape.type === "arrow") {
    return { ...shape, x1: shape.x1 + dx, y1: shape.y1 + dy, x2: shape.x2 + dx, y2: shape.y2 + dy };
  }
  return { ...shape, points: shape.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
}

function shapeBounds(shape: Shape) {
  if (shape.type === "rect") {
    return {
      minX: Math.min(shape.x, shape.x + shape.width),
      minY: Math.min(shape.y, shape.y + shape.height),
      maxX: Math.max(shape.x, shape.x + shape.width),
      maxY: Math.max(shape.y, shape.y + shape.height),
    };
  }
  if (shape.type === "text") {
    const w = shape.text.length * shape.fontSize * 0.6;
    return {
      minX: shape.x, minY: shape.y,
      maxX: shape.x + w, maxY: shape.y + shape.fontSize,
    };
  }
  if (shape.type === "circle") {
    return {
      minX: shape.centerX - shape.radius, minY: shape.centerY - shape.radius,
      maxX: shape.centerX + shape.radius, maxY: shape.centerY + shape.radius,
    };
  }
  if (shape.type === "line" || shape.type === "arrow") {
    return {
      minX: Math.min(shape.x1, shape.x2), minY: Math.min(shape.y1, shape.y2),
      maxX: Math.max(shape.x1, shape.x2), maxY: Math.max(shape.y1, shape.y2),
    };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of shape.points) {
    if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function drawSelection(ctx: CanvasRenderingContext2D, shape: Shape, scale: number) {
  const b = shapeBounds(shape);
  const pad = 6 / scale;
  ctx.save();
  ctx.strokeStyle = "#a6ff5e";
  ctx.lineWidth = 1.5 / scale;
  ctx.setLineDash([6 / scale, 4 / scale]);
  ctx.strokeRect(b.minX - pad, b.minY - pad, (b.maxX - b.minX) + pad * 2, (b.maxY - b.minY) + pad * 2);
  ctx.restore();
}


export function applyOp(shapes: Shape[], op: CanvasOp): Shape[] {
  if (op.opType === "CREATE"){
    const next = op.payload;
    if (!next) {
      return shapes;
    }
    if (shapes.some((s) => s.id === op.shapeId)) {
      return shapes;
    }
    return [...shapes, next];
  }

  if (op.opType === "UPDATE") {
    const next = op.payload;
    if (!next) {
      return shapes;
    }
    return shapes.map((s) => (s.id === op.shapeId ? next : s));
  }

  if (op.opType === "DELETE"){
    return shapes.filter((s) => s.id !== op.shapeId);
  }
  return shapes;

}

// O(n) batch replay of an op log, equivalent to ops.reduce(applyOp, []) but
// without rebuilding the whole array per op (that fold is O(n^2)). Keeps a Map
// keyed by shapeId; Map iteration order == insertion order, which mirrors the
// append-order applyOp produces: the first successful CREATE fixes a shape's
// position, UPDATE replaces it in place, DELETE removes it, and a later
// re-CREATE re-appends at the end.
//
// We fold in ARRAY order and never sort. That is what guarantees
// foldOps(ops) === ops.reduce(applyOp, []) element-for-element for ANY input,
// and it keeps stateAtSeq correct for optimistic live ops whose seq is still
// undefined. seq order is only asserted defensively (dev only), never enforced.
//
// Per-branch semantics are an exact mirror of applyOp above.
export function foldOps(ops: CanvasOp[]): Shape[] {
  if (process.env.NODE_ENV !== "production") {
    let prev = -Infinity;
    for (const op of ops) {
      if (op.seq === undefined) continue;
      if (op.seq < prev) {
        console.warn("foldOps: ops not in non-decreasing seq order; folding in array order anyway");
        break;
      }
      prev = op.seq;
    }
  }

  const byId = new Map<string, Shape>();
  for (const op of ops) {
    if (op.opType === "CREATE") {
      if (!op.payload) continue; // null payload -> no-op
      if (byId.has(op.shapeId)) continue; // duplicate CREATE -> keep the first
      byId.set(op.shapeId, op.payload);
    } else if (op.opType === "UPDATE") {
      if (!op.payload) continue; // null payload -> no-op
      if (!byId.has(op.shapeId)) continue; // UPDATE of absent id -> no-op (adds nothing)
      byId.set(op.shapeId, op.payload); // full replace (applyOp replaces, not merges)
    } else if (op.opType === "DELETE") {
      byId.delete(op.shapeId); // absent id -> no-op
    }
  }
  return Array.from(byId.values());
}

export function stateAtSeq(ops: CanvasOp[], maxSeq: number): Shape[] {
  return foldOps(ops.filter((o) => (o.seq ?? 0) <= maxSeq));
}


export async function fetchOperations(roomId: number): Promise<CanvasOp[]> {
  const token = localStorage.getItem("token") ?? "";
  const res = await fetch(`${BACKEND_URL}/operations/${roomId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    console.error(`fetchOperations ${roomId} failed: ${res.status} ${res.statusText}`);
    if (res.status === 401) {
      localStorage.removeItem("token");
    }
    return [];
  }

  const data = await res.json();

  return (data.operations ?? []).map((row : {
    seq: number;
    type: OpType;
    shapeId: string;
    payload: Shape | null
  }) => ({
    opType: row.type,
    shapeId: row.shapeId,
    payload: row.payload ?? null,
    seq: row.seq,
  }));
}