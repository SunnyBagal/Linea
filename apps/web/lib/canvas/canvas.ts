import { Shape } from "./types";
import { BACKEND_URL } from "../../config";

export function getCanvasPos(e: MouseEvent, canvas: HTMLCanvasElement) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

export function redraw(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  shapes: Shape[]
) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#111";
  ctx.lineWidth = 2;

  for (const shape of shapes) {
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
}


export async function fetchShapes(roomId: number): Promise<Shape[]> {
  const token = localStorage.getItem("token") ?? "";
  const res = await fetch(`${BACKEND_URL}/chats/${roomId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = await res.json();

  const shapes: Shape[] = [];
  for (const m of data.messages) {
    try {
      shapes.push(JSON.parse(m.message));
    } catch {
      // skip non-JSON rows (old chat test data)
    }
  }
  return shapes;
}