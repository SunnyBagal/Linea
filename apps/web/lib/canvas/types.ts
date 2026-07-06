import type { Shape, ShapeGeometry } from "@repo/common/types";

export type { Shape, ShapeGeometry };

export type Tool = "select" | "rect" | "circle" | "line" | "arrow" | "pencil" | "text";

export type Camera = { x: number; y: number; scale: number };

export type OpType = "CREATE" | "UPDATE" | "DELETE";

export type CanvasOp = {
  opType: OpType;
  shapeId: string;
  payload: Shape | null;
  seq?: number;
};