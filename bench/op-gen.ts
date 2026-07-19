// op-gen.ts — realistic, ShapeSchema-valid op generation, shared by seed-ops.ts
// (builds a fixed-length sequence) and bench-ws.ts (streams ops live). Pure: no
// DB, no side effects, no top-level work.

import { ShapeSchema, type Shape } from "@repo/common/types";

export type OpType = "CREATE" | "UPDATE" | "DELETE";

// An op in the shape the DB stores / the WS `op` frame carries. payload is a
// full Shape for CREATE/UPDATE and null for DELETE.
export interface GenOp {
  opType: OpType;
  shapeId: string;
  payload: Shape | null;
}

// Deterministic RNG (mulberry32) so seeded datasets and paced runs are stable.
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORLD = 2000;
const WORDS = ["idea", "todo", "api", "db", "flow", "auth", "cache", "queue", "user", "note"];

// Weighted toward the shapes users draw most; text/pencil rarer.
const SHAPE_TYPES = [
  { type: "rect", weight: 0.3 },
  { type: "circle", weight: 0.2 },
  { type: "line", weight: 0.15 },
  { type: "arrow", weight: 0.15 },
  { type: "pencil", weight: 0.12 },
  { type: "text", weight: 0.08 },
] as const;

interface LastOp {
  type: OpType;
  shapeId: string;
  before: Shape | null; // state to restore on undo (UPDATE/DELETE)
  after: Shape | null; // state produced by the op (CREATE/UPDATE)
}

// Stateful generator: tracks live shapes so UPDATE/DELETE reference earlier
// shapes, and emits occasional compensating-op undos (create->delete,
// update->restore, delete->recreate) — the pattern Linea's undo produces.
export class OpGenerator {
  private rng: () => number;
  private live = new Map<string, Shape>();
  private idCounter = 0;
  private last: LastOp | null = null;

  constructor(seed = 0x1117ea) {
    this.rng = makeRng(seed);
  }

  get liveCount(): number {
    return this.live.size;
  }

  private randInt(min: number, max: number): number {
    return Math.floor(this.rng() * (max - min + 1)) + min;
  }
  private randFloat(min: number, max: number): number {
    return this.rng() * (max - min) + min;
  }
  private pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.rng() * arr.length)]!;
  }

  private newShapeId(): string {
    this.idCounter += 1;
    return `bench-shape-${this.idCounter}-${this.randInt(1000, 9999)}`;
  }

  private pickShapeType(): (typeof SHAPE_TYPES)[number]["type"] {
    const r = this.rng();
    let acc = 0;
    for (const s of SHAPE_TYPES) {
      acc += s.weight;
      if (r <= acc) return s.type;
    }
    return "rect";
  }

  private makeShape(id: string): Shape {
    const type = this.pickShapeType();
    switch (type) {
      case "rect":
        return { id, type: "rect", x: this.randFloat(0, WORLD), y: this.randFloat(0, WORLD), width: this.randFloat(10, 400), height: this.randFloat(10, 400) };
      case "circle":
        return { id, type: "circle", centerX: this.randFloat(0, WORLD), centerY: this.randFloat(0, WORLD), radius: this.randFloat(5, 300) };
      case "line":
        return { id, type: "line", x1: this.randFloat(0, WORLD), y1: this.randFloat(0, WORLD), x2: this.randFloat(0, WORLD), y2: this.randFloat(0, WORLD) };
      case "arrow":
        return { id, type: "arrow", x1: this.randFloat(0, WORLD), y1: this.randFloat(0, WORLD), x2: this.randFloat(0, WORLD), y2: this.randFloat(0, WORLD) };
      case "pencil": {
        const n = this.randInt(2, 40); // multi-point paths; schema requires >= 2
        const points = Array.from({ length: n }, () => ({ x: this.randFloat(0, WORLD), y: this.randFloat(0, WORLD) }));
        return { id, type: "pencil", points };
      }
      case "text":
        return { id, type: "text", x: this.randFloat(0, WORLD), y: this.randFloat(0, WORLD), text: `${this.pick(WORDS)} ${this.pick(WORDS)}`, fontSize: this.randInt(12, 48) };
    }
  }

  private translate(shape: Shape, dx: number, dy: number): Shape {
    switch (shape.type) {
      case "text":
      case "rect":
        return { ...shape, x: shape.x + dx, y: shape.y + dy };
      case "circle":
        return { ...shape, centerX: shape.centerX + dx, centerY: shape.centerY + dy };
      case "line":
      case "arrow":
        return { ...shape, x1: shape.x1 + dx, y1: shape.y1 + dy, x2: shape.x2 + dx, y2: shape.y2 + dy };
      case "pencil":
        return { ...shape, points: shape.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    }
  }

  private doCreate(): GenOp {
    const id = this.newShapeId();
    const shape = this.makeShape(id);
    this.live.set(id, shape);
    this.last = { type: "CREATE", shapeId: id, before: null, after: shape };
    return { opType: "CREATE", shapeId: id, payload: shape };
  }

  private doUpdate(): GenOp {
    const id = this.pick([...this.live.keys()]);
    const before = this.live.get(id)!;
    const after = this.translate(before, this.randFloat(-100, 100), this.randFloat(-100, 100));
    this.live.set(id, after);
    this.last = { type: "UPDATE", shapeId: id, before, after };
    return { opType: "UPDATE", shapeId: id, payload: after };
  }

  private doDelete(): GenOp {
    const id = this.pick([...this.live.keys()]);
    const before = this.live.get(id)!;
    this.live.delete(id);
    this.last = { type: "DELETE", shapeId: id, before, after: null };
    return { opType: "DELETE", shapeId: id, payload: null };
  }

  private doUndo(): GenOp | null {
    const last = this.last;
    if (!last) return null;
    if (last.type === "CREATE") {
      if (!this.live.has(last.shapeId)) return null;
      this.live.delete(last.shapeId);
      this.last = { type: "DELETE", shapeId: last.shapeId, before: last.after, after: null };
      return { opType: "DELETE", shapeId: last.shapeId, payload: null };
    }
    if (last.type === "UPDATE") {
      if (!this.live.has(last.shapeId) || !last.before) return null;
      this.live.set(last.shapeId, last.before);
      this.last = { type: "UPDATE", shapeId: last.shapeId, before: last.after, after: last.before };
      return { opType: "UPDATE", shapeId: last.shapeId, payload: last.before };
    }
    // DELETE -> re-create the removed shape
    if (!last.before || this.live.has(last.shapeId)) return null;
    this.live.set(last.shapeId, last.before);
    this.last = { type: "CREATE", shapeId: last.shapeId, before: null, after: last.before };
    return { opType: "CREATE", shapeId: last.shapeId, payload: last.before };
  }

  // Produce the next op: mostly CREATE, plus UPDATE drags, DELETEs, and ~10%
  // compensating undos. Forces CREATE when nothing is live.
  next(): GenOp {
    if (this.live.size === 0) return this.doCreate();
    if (this.rng() < 0.1) {
      const undo = this.doUndo();
      if (undo) return undo;
    }
    const r = this.rng();
    if (r < 0.55) return this.doCreate();
    if (r < 0.85) return this.doUpdate();
    return this.doDelete();
  }
}

// Validate a payload against the production Zod schema (throws if invalid).
export function assertValidPayload(op: GenOp): void {
  if (op.payload !== null) ShapeSchema.parse(op.payload);
}
