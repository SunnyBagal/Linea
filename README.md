# Linea

A collaborative whiteboard for fast-moving teams. Sketch, point, and decide together in real time, right in the browser. Think Excalidraw, but built from scratch to understand how the whole thing actually works underneath.

Live shapes, hand-drawn rendering, multiplayer sync, undo, and full time-travel over an append-only operation log.

---

## Why I built this

I used Figma and Excalidraw for the first time in my second year of college and I loved both of them instantly. I kept wondering how people built something that felt so effortless to use. Excalidraw especially became part of my daily routine. I used it to plot out CS concepts, sketch ideas, and think through problems visually.

The part that hooked me was its Mermaid support. I would write a prompt, get Mermaid syntax back, paste it into Excalidraw, and watch a full flowchart, sequence diagram, class diagram, or ER diagram appear. That single workflow carried me through a lot of assignments and a lot of learning, and I still use Excalidraw almost every day.

At some point "I wonder how this works" turned into "I want to build one." So I did.

This took me more than a month. Even with AI as a pair-programmer, it took that long on purpose, because I wanted to understand every piece before I wrote it, not just paste something that worked. The core logic on the canvas, the coordinate math, the operation log, the sync model, the undo, the time-travel, is mine. I used AI to reason through architecture and to move faster on mechanical wiring, but I made the design decisions and I can explain every one of them.

For the frontend polish (the landing page and the sign-in / sign-up screens) I tested out Claude's Fable 5 model and it genuinely exceeded my expectations. It hallucinated occasionally, but the overall output was strong. I only used it for frontend generation. Every line of backend code, the WebSocket server, the operation log, the schema, the auth, I wrote and reasoned through myself.

---

## What it does

- Freehand drawing plus rectangles, circles, lines, arrows, and text
- Real-time multiplayer sync over WebSockets
- Infinite canvas with pan and zoom (Figma-style, zoom toward the cursor)
- Select, drag, and delete any shape
- Undo, per-user, in a shared session
- Time-travel: scrub back through the entire history of the board
- Hand-drawn rendering with Rough.js
- Dark and light themes
- High-DPI (retina) crisp rendering
- Slug-based rooms so canvases can't be guessed by walking through IDs

---

## Tech stack

**Frontend:** Next.js (App Router), raw Canvas 2D, Rough.js, TypeScript
**Backend:** two Express services, one HTTP and one WebSocket
**Database:** PostgreSQL with Prisma
**Validation:** Zod, shared across client and server
**Monorepo:** Turborepo with pnpm workspaces
**Auth:** email + password with JWT (argon2id hashing)

---

## Things I learned building this

### Monorepos

This was my first monorepo, and at the start it frustrated me. Every shared piece of code had to be exported properly from its own package, every folder needed its own `package.json`, and keeping dependencies aligned across the workspace felt like a lot of overhead. After about a week it clicked, and now I actually prefer working this way. A single source of truth for shared types and schemas across the frontend and both backends is worth the setup cost.

### Canvas 2D and the freehand problem

Working directly with the Canvas 2D API was new to me. Understanding how shapes are drawn, cleared, and repainted every frame took a while to sink in.

Freehand drawing was the first real challenge. A "free draw" stroke is really just a lot of tiny straight line segments stitched together, and I was storing every single point in the database. During testing my Postgres rows for a single long stroke got huge, and I could see this becoming a real problem at scale.

The fix was the Ramer-Douglas-Peucker algorithm, which simplifies a line by dropping points that don't meaningfully change its shape. I combined it with distance-based thinning while drawing (skip points that are too close to the last one) so the stroke that actually gets stored is a fraction of the raw input, without looking any different. That was not an easy thing to get right, but it taught me a lot about the difference between what you capture and what you persist.

### Selecting and moving shapes

Selecting a shape, dragging it, and persisting its new position sounds simple. It isn't. It meant hit-testing every shape type correctly (a point-near-a-line test is very different from a point-inside-a-rectangle test), tracking the drag in world coordinates so it stays accurate at any zoom, and committing the move as a clean update rather than a flood of tiny ones.

### The text tool

Adding text gave me the most errors of anything in the project. Canvas can't receive typed input, so text means overlaying a real HTML input at the click position, capturing keystrokes there, and only then turning it into a canvas shape. I hit focus bugs, stale-value bugs, and event handlers on the window stealing my keystrokes mid-word. At one point almost every function had a `console.log` in it so I could see exactly where things were breaking. I got it working, and I understand the whole input-to-canvas dance now.

### Moving the whole app onto an operation log (the big one)

This is the part I'm most proud of.

At first, shapes were sent and stored as plain messages, basically tunneled through a chat channel. That worked for drawing, but it couldn't support anything more advanced. So I re-architected the entire persistence model into an **append-only operation log**.

Instead of storing "here is the current board," the database stores an ordered sequence of operations: create this shape, update that one, delete this other one. The current state of the board is what you get by folding that whole log through a single pure reducer function. Every op gets a per-room sequence number assigned atomically on the server, which gives every operation a strict order.

Understanding and implementing this shift was genuinely challenging, but it's the foundation that makes everything else possible. The same reducer drives live collaboration, reload hydration, undo, and time-travel. I just replay a different slice of the same log for each.

### Time-travel

I originally wanted time-travel to be read AND write, meaning you could scrub back to a past state and start editing from there. I learned pretty quickly why that's a much bigger problem than it sounds.

A read-only log is linear. "The board at version 20" is just "fold the first 20 operations." Simple and always consistent. But editing from the past forks history into a tree, and the moment two people can diverge from different points you're into conflict-resolution and CRDT territory, which is a whole separate project. So time-travel is read-only by design, and being able to explain *why* that boundary exists taught me more than forcing the feature would have.

The scrubbing itself is the payoff of the operation-log work: because state is just a fold of the log, viewing any past moment is folding a shorter prefix. The feature almost fell out of the architecture for free.

### Undo in a shared session

Undo is per-user. If I draw something and undo it, your work isn't touched, and vice versa. That sounds like a small thing, but it's technically involved. Undo doesn't rewrite history (the log is append-only), it *appends the inverse*: undoing a create appends a delete, undoing a delete appends a create, undoing a move appends a move back. Each user tracks their own stack of inverse operations. Keeping that correct in a live, multi-user session was one of the more satisfying problems to solve.

### Databases and relations

I understood basic Postgres going in, but designing the actual schema, the relations between users, rooms, and operations, the cascade rules, the unique constraints that guarantee no gaps or duplicates in the operation sequence, was new to me. Getting all of that to connect cleanly was a real learning curve and a genuinely useful one.

### Zod and discriminated unions

I put off adding Zod validation because I assumed a shape schema would need some elaborate setup. It turned out to be straightforward: the shapes are mostly numbers. The interesting part was learning **discriminated unions**, where a single `type` field tells the validator which exact shape of object to expect. I ended up defining the shape schema once in Zod and inferring the TypeScript types from it, so the wire format, the validation, and the client types can never drift apart. One source of truth.

### Auth: the BetterAuth decision

I was about to integrate BetterAuth because it had caught my eye, but I stepped back and reconsidered. My WebSocket authentication works by attaching the JWT to the connection URL and verifying it directly on the socket server. BetterAuth is session and cookie based, which is a different model, and wiring it into a raw WebSocket handshake would have meant days of untangling how its sessions travel over a socket connection. For a JWT-in-the-URL setup, sticking with plain JWT was the right call. Sometimes the best technical decision is not adding the shiny thing.

### Slug-based rooms

Early on, a room was identified by an auto-incrementing number, so the URL was `/canvas/5`. Which means anyone could just type `/canvas/6`, `/canvas/7`, and walk straight into other people's boards. Before this could ever be deployed, I switched rooms to be keyed by a random unguessable slug, so a canvas link is effectively the access token. The numeric ID still exists internally, but it never appears in a URL.

---

## Architecture in one line

State is a pure fold over an append-only, server-sequenced operation log. The same reducer drives live collaboration, reload hydration, undo via inverse operations, and time-travel via prefix replay. Everything else is built on that.

---

## Running it locally

```bash
pnpm install
pnpm dev
```

This starts the Next.js frontend, the HTTP backend, and the WebSocket backend together. You'll need a running Postgres instance and a `DATABASE_URL` set for the database package.

---

## What's next

- Live collaborative cursors (see who's drawing where, in real time)
- Resize handles for shapes
- Restore-to-version (Figma-style), which appends a revert forward and keeps the log linear

---

Built by Sunny. This one took a while, and I understand every part of it.
