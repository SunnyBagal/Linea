# Linea

A real-time collaborative whiteboard built from scratch. Sketch, diagram, and think together in the browser, with an architecture designed around a single idea: the board is not a picture, it's a log of everything that ever happened to it.

Live multiplayer sync, hand-drawn rendering, per-user undo, and full time-travel, all powered by an append-only operation log.

---

## Table of contents

- [Overview](#overview)
- [Why I built this](#why-i-built-this)
- [Features](#features)
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
  - [The operation log](#the-operation-log)
  - [The reducer](#the-reducer)
  - [Real-time sync](#real-time-sync)
  - [Undo as compensating operations](#undo-as-compensating-operations)
  - [Time-travel](#time-travel)
  - [Coordinate system](#coordinate-system)
  - [Rendering](#rendering)
- [Data model](#data-model)
- [Project structure](#project-structure)
- [Running locally](#running-locally)
- [Engineering decisions](#engineering-decisions)
- [What I learned](#what-i-learned)
- [Roadmap](#roadmap)

---

## Overview

Linea is a collaborative drawing tool in the spirit of Excalidraw. Multiple people can join the same board and draw together in real time. It supports freehand strokes, rectangles, circles, lines, arrows, and text, on an infinite pannable and zoomable canvas.

The interesting part is not the drawing. It's that the entire application state is modeled as an ordered, append-only sequence of operations, and every feature (live collaboration, reload persistence, undo, and time-travel) is a different way of reading that one sequence.

---

## Why I built this

I started using Figma and Excalidraw in my second year of college and became fascinated by how something so complex could feel so simple to use. Excalidraw in particular became a daily tool for me, especially its Mermaid support, which let me turn text into full diagrams and carried me through a lot of coursework.

Curiosity about how it worked eventually turned into a decision to build one myself. This project took over a month. Even with AI assistance, I kept the pace deliberate so I could understand each piece before implementing it. The canvas logic, the sync model, the operation log, the undo system, and the time-travel feature are all mine. The landing page and auth screens were generated with Claude's Fable 5 model as an experiment in AI-assisted frontend work, and they turned out well. All backend code was written by hand.

---

## Features

| Feature | Detail |
|---|---|
| Shapes | Freehand, rectangle, circle, line, arrow, text |
| Real-time collaboration | WebSocket sync across all clients in a room |
| Infinite canvas | Pan and zoom, with zoom anchored to the cursor |
| Selection and editing | Hit-testing per shape type, drag to move, delete |
| Undo | Per-user, in a shared session, via inverse operations |
| Time-travel | Scrub through the full history of the board |
| Hand-drawn look | Rough.js rendering with a per-shape cache |
| Theming | Dark and light modes |
| High-DPI | Sharp rendering on retina displays |
| Secure rooms | Random unguessable slugs instead of sequential IDs |
| Self-healing connection | Automatic WebSocket reconnect with backoff |

---

## Tech stack

**Frontend**
- Next.js with the App Router
- Raw Canvas 2D API (no drawing library for the core engine)
- Rough.js for hand-drawn rendering
- TypeScript throughout

**Backend**
- Two Express services: one HTTP API, one WebSocket server
- JWT authentication with argon2id password hashing

**Data**
- PostgreSQL with Prisma
- Zod for validation, shared between client and server

**Tooling**
- Turborepo monorepo with pnpm workspaces

---

## Architecture

### The operation log

Most drawing apps store the current state of the board: here are the shapes, here are their positions. Linea does not. It stores an ordered log of **operations**:

```
seq 1: CREATE  rectangle A
seq 2: CREATE  circle B
seq 3: UPDATE  rectangle A (moved)
seq 4: DELETE  circle B
```

The current board is not stored anywhere directly. It's a *derived value*, computed by replaying the log from the beginning through a reducer. This is the single most important design decision in the project, because it means the board's entire history is preserved for free, and every other feature is built on reading this one sequence.

Each operation is assigned a per-room sequence number (`seq`), incremented atomically inside a database transaction on the server. That atomic increment is what guarantees a strict, gap-free total order of operations within a room, even under concurrent writes.

### The reducer

State is produced by folding the log through a single pure function:

```
currentState = operations.reduce(applyOp, [])
```

`applyOp` is small and total:
- `CREATE` appends the shape (idempotent, so replaying is safe)
- `UPDATE` replaces the shape with a matching id
- `DELETE` removes the shape with a matching id

Because it's pure and deterministic, the same reducer is reused everywhere: to hydrate the board on page load, to apply live operations as they arrive, to power undo, and to render any past version. One function, one definition of what an operation means.

### Real-time sync

When you draw, the client optimistically applies the operation locally and sends it to the WebSocket server. The server validates it with Zod, persists it with its assigned sequence number, and broadcasts it to every other client in the room. Those clients run the exact same reducer to fold it in.

The server excludes the sender from its own broadcast (you already applied it locally), and sends the sender a small acknowledgement carrying the assigned sequence number, so the sender's in-memory log stays correctly ordered.

On join, the client fetches the full operation log over HTTP and replays it to reconstruct the board. Operations that arrive over the socket during that fetch are buffered and flushed afterward, so nothing is lost in the race between hydration and live updates.

### Undo as compensating operations

The log is append-only, so undo never deletes or rewrites history. Instead it **appends the inverse**:

| You did | Undo appends |
|---|---|
| CREATE | DELETE |
| DELETE | CREATE (with the saved shape) |
| UPDATE | UPDATE (back to the previous state) |

Each user maintains their own stack of inverse operations, captured at the moment of the action while the "before" state is still available. Because undo is just another operation broadcast to the room, it syncs to everyone through the same path as any other change, and it's per-user by construction: undoing my last action has no effect on yours.

### Time-travel

Since current state is a fold of the whole log, any past state is a fold of a **prefix** of the log:

```
stateAtVersion(N) = operations.filter(op => op.seq <= N).reduce(applyOp, [])
```

A slider scrubs the sequence number and re-folds. This is intentionally read-only. A linear log makes "the board at version N" cheap and always consistent. Allowing edits from the past would fork the log into a branching tree and turn every viewer into a merge-conflict problem, which is a separate class of engineering (CRDTs and operational transforms). Keeping time-travel read-only keeps the log linear and the model simple, and the feature nearly falls out of the architecture for free.

While scrubbing, incoming operations from collaborators are still appended to the in-memory log, they just don't disturb the frozen view. Exiting time-travel snaps back to the live present, which now includes anything that arrived while you were looking at the past.

### Coordinate system

The canvas is infinite, so there are two coordinate spaces:
- **World coordinates**, where shapes actually live and are stored
- **Screen coordinates**, what the user's mouse reports

A camera (`{ x, y, scale }`) projects world onto screen. Every mouse position is converted to world space before it touches a shape, and rendering applies the camera as a canvas transform. The camera is per-viewer local state: it's never persisted and never broadcast, so two people can be zoomed to different parts of the same board at the same time. Zoom is anchored to the cursor by computing the world point under the mouse before scaling and adjusting the camera so that point stays put.

### Rendering

Committed shapes are drawn with Rough.js for a hand-drawn look. Rough is expensive (it computes sketch geometry), so drawables are cached per shape, keyed by content, and the roughness seed is derived from the shape's id so a given shape never re-rolls its jitter between frames. The in-progress preview while you draw uses plain Canvas 2D for speed, then snaps to the hand-drawn style on commit.

High-DPI rendering scales the canvas backing store by the device pixel ratio while keeping all coordinate math in CSS pixels, so strokes are crisp on retina screens without breaking hit-testing or zoom.

---

## Data model

The core tables:

- **User** owns rooms and operations
- **Room** has a unique slug and a `currentSeq` counter (the atomic per-room sequence source)
- **Operation** is the log: `roomId`, `seq`, `type`, `shapeId`, `payload` (the shape as JSON), `userId`, with a unique constraint on `(roomId, seq)` to guarantee no gaps or duplicates in the order
- **Snapshot** exists for a future optimization (materializing state at a sequence so replay doesn't start from zero on very large boards)

The `(roomId, seq)` unique constraint is doing real work: it's the database-level guarantee that the operation order is well-defined.

---

## Project structure

```
graphite/
├── apps/
│   ├── web/            Next.js frontend
│   ├── http-backend/   Express HTTP API (auth, rooms, operation history)
│   └── ws-backend/     Express WebSocket server (live sync)
└── packages/
    ├── common/         Shared Zod schemas and inferred types
    ├── db/             Prisma schema and client
    └── ui/             Shared UI components
```

Shapes are defined once as a Zod schema in `packages/common` and the TypeScript types are inferred from it, so the wire format, server validation, and client types cannot drift apart.

---

## Running locally

Requirements: Node, pnpm, and a running PostgreSQL instance.

```bash
pnpm install

# set DATABASE_URL for the db package, then:
pnpm --filter @repo/db exec prisma migrate dev

pnpm dev
```

`pnpm dev` starts the frontend, the HTTP backend, and the WebSocket backend together via Turborepo.

---

## Engineering decisions

**Raw Canvas 2D instead of a library.** Using Fabric or Konva would have hidden the exact thing I wanted to learn. The source of truth is a plain array of shapes repainted each frame, which kept the model transparent.

**Operation log instead of storing current state.** This is what makes undo, persistence, and time-travel share one mechanism instead of three. It was more work upfront and paid for itself many times over.

**JWT over session-based auth.** The WebSocket server verifies the JWT directly from the connection URL. A cookie-and-session library like BetterAuth would have required reworking how identity travels across the socket handshake, so plain JWT was the correct fit for this transport.

**Random slugs for rooms.** Sequential numeric IDs meant anyone could enumerate their way into other people's boards. Rooms are keyed by an unguessable slug, so the link itself acts as the access token.

**Point simplification for freehand.** A freehand stroke is many tiny segments, and storing every raw point bloated the database fast. Distance-based thinning during drawing plus the Ramer-Douglas-Peucker algorithm on commit cut stored points dramatically with no visible change to the stroke.

---

## What I learned

- How an append-only event log unifies persistence, undo, and history into one model
- Why collaborative editing of the past is fundamentally a branching/merge problem
- Working directly with the Canvas 2D API and managing two coordinate spaces
- Designing relational schemas with constraints that enforce real invariants
- Zod discriminated unions and inferring types from a single schema source
- The practical realities of a monorepo: shared packages, workspace dependencies, one source of truth
- Making deliberate technical decisions, including deciding *not* to add things

---

## Roadmap

- Live collaborative cursors with per-user color and presence
- Resize handles for shapes
- Restore-to-version (append a revert-forward operation, keeping the log linear)
- Snapshotting for faster hydration on very large boards

---

Built as a deep-dive into how real collaborative tools work underneath. Every architectural decision here is one I can explain and defend.
