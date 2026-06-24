import { Shape } from "./types";

export function redraw(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, shapes: Shape[]) {

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (const shape of shapes) {
    if (shape.type === "rect") {
      ctx.strokeRect(shape.x, shape.y, shape.width, shape.height)
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
      ctx.lineTo(shape.x2 - head * Math.cos(angle - Math.PI / 6), shape.y2 - head * Math.sin(angle - Math.PI / 6));
      ctx.moveTo(shape.x2, shape.y2);
      ctx.lineTo(shape.x2 - head * Math.cos(angle + Math.PI / 6), shape.y2 - head * Math.sin(angle + Math.PI / 6));
      ctx.stroke();
    }

    else if (shape.type === "pencil") {
      ctx.beginPath();
      shape.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
      ctx.stroke();
    }


  }
}