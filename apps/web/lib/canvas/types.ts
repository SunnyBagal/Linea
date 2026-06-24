export type Shape =
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