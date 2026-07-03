export type ShapeGeometry =
  | { 
        type: "rect";
        x: number;
        y: number;
        width: number;
        height: number 
      }
  | { 
      type: "circle";
      centerX: number;
      centerY: number;
      radius: number 
    }
  | { 
      type: "line"; 
      x1: number; 
      y1:number; 
      x2: number; 
      y2: number
    } 
  | {
      type: "arrow";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    }
  | {
      type: "pencil";
      points: { x: number; y: number;}[]
  }

export type Shape = ShapeGeometry & { id: string };

export type Tool = "rect" | "circle" | "line" | "arrow" | "pencil";

export type Camera = { x: number; y: number; scale: number };

export type OpType = "CREATE" | "UPDATE" | "DELETE"

export type CanvasOp = {
  opType: OpType;
  shapeId: string;
  payload: Shape | null
}