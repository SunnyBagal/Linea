import { Shape, ShapeGeometry, Tool, Camera } from "./types";
import { BACKEND_URL } from "../../config";

export const MIN_SCALE = 0.1;
export const MAX_SCALE = 8;
const GRID_SIZE = 40;

export function screenToWorld(sx: number, sy: number, cam: Camera) {
  return { x: (sx - cam.x) / cam.scale, y: (sy - cam.y) / cam.scale };
}

export function getCanvasPos(e: MouseEvent, canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

export function drawShape(ctx: CanvasRenderingContext2D, shape: Shape) {
  ctx.strokeStyle = "#111";
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
  cam: Camera
) {
  // Clear in screen space (identity), then switch to world space.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(cam.scale, 0, 0, cam.scale, cam.x, cam.y);

  drawGrid(ctx, canvas, cam);
  for (const shape of shapes) drawShape(ctx, shape);
  // NOTE: transform is left applied on exit, so the live preview
  // in onMove draws in world space through the same transform.
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  cam: Camera
) {
  const left = -cam.x / cam.scale;
  const top = -cam.y / cam.scale;
  const right = (canvas.width - cam.x) / cam.scale;
  const bottom = (canvas.height - cam.y) / cam.scale;

  // Level-of-detail: double the step until the visible line count is sane.
  let step = GRID_SIZE;
  while ((right - left) / step > 80) step *= 2;

  const startX = Math.floor(left / step) * step;
  const startY = Math.floor(top / step) * step;

  ctx.strokeStyle = "rgba(0,0,0,0.06)";
  ctx.lineWidth = 1 / cam.scale; // constant ~1px regardless of zoom
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
    }
  }
  return { minX, minY, maxX, maxY };
}


export async function fetchShapes(roomId: number): Promise<Shape[]> {
  const token = localStorage.getItem("token") ?? "";
  const res = await fetch(`${BACKEND_URL}/chats/${roomId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    console.error(`fetchShapes ${roomId} failed: ${res.status} ${res.statusText}`);
    if (res.status === 401) {
      localStorage.removeItem("token");
    }
    return [];
  }

  const data = await res.json();

  const shapes: Shape[] = [];
  for (const m of data.messages) {
    try {
      const parsed = JSON.parse(m.message);
      if (typeof parsed.id !== "string") parsed.id = crypto.randomUUID();
      shapes.push(parsed);
    } catch {
      // skip non-JSON legacy rows
    }
  }
  
  return shapes;
}