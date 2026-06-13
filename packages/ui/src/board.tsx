"use client";
/* packages/ui/src/board.tsx — live board scenes (decorative). */
import { type ReactNode, useEffect, useRef } from "react";

/* ---------- shared chrome ---------- */
function Cursor({ name, color, ink, chipWidth = 44, children }: {
  name: string; color: string; ink: string; chipWidth?: number; children?: ReactNode;
}) {
  return (
    <>
      <path d="M0 0 L0 16 L4.6 12.6 L7.4 18.6 L10 17.4 L7.2 11.6 L12.6 11 Z" fill={color} stroke="#0b0d0b" strokeWidth="0.8" />
      <rect x="13" y="13" width={chipWidth} height="21" rx="10.5" fill={color} />
      <text x={13 + chipWidth / 2} y="27.5" textAnchor="middle" fill={ink} className="ln-chip-text">{name}</text>
      {children}
    </>
  );
}

function ToolIcon({ title, active = false, children }: { title: string; active?: boolean; children: ReactNode }) {
  return (
    <span title={title} className={"grid h-8 w-8 place-items-center rounded-lg " + (active ? "ln-tool-active" : "ln-text-2")}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </span>
  );
}

function Toolbar() {
  return (
    <div className="ln-glass absolute left-1/2 top-4 z-10 flex -translate-x-1/2 gap-1 rounded-2xl p-1.5">
      <ToolIcon title="Select"><path d="M4 3l7.5 18 2.4-7.1L21 11.5 4 3z" /></ToolIcon>
      <ToolIcon title="Rectangle"><rect x="4" y="5" width="16" height="14" rx="2" /></ToolIcon>
      <ToolIcon title="Ellipse"><ellipse cx="12" cy="12" rx="8.5" ry="6.5" /></ToolIcon>
      <ToolIcon title="Draw" active><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></ToolIcon>
      <ToolIcon title="Text"><><path d="M5 6V4h14v2" /><path d="M12 4v16" /><path d="M9 20h6" /></></ToolIcon>
    </div>
  );
}

function Presence() {
  return (
    <div className="ln-glass absolute bottom-4 left-4 flex items-center gap-2.5 rounded-full py-1.5 pl-2 pr-3.5">
      <span className="flex">
        <i className="ln-av" style={{ background: "#a6ff5e" }}>M</i>
        <i className="ln-av -ml-2" style={{ background: "#aab8ff" }}>D</i>
        <i className="ln-av -ml-2" style={{ background: "#ffd479" }}>A</i>
      </span>
      <span className="ln-text-2 flex items-center gap-2 text-xs"><span className="ln-pulse-dot" />3 sketching live</span>
    </div>
  );
}

/* Reduced motion: strip SMIL, show drawn strokes, park the drawing cursor. */
function useReducedMotion(boardRef: React.RefObject<SVGSVGElement | null>, parkAt: string) {
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      if (!reduced.matches || !boardRef.current) return;
      boardRef.current.querySelectorAll(".smil").forEach((el) => el.remove());
      const mira = boardRef.current.querySelector(".ln-mira-g");
      if (mira) mira.setAttribute("transform", parkAt);
    };
    apply();
    reduced.addEventListener?.("change", apply);
    return () => reduced.removeEventListener?.("change", apply);
  }, [boardRef, parkAt]);
}

/* ============================================================
   AUTH BOARD — portrait scene (sign in / sign up pages)
   ============================================================ */
const AUTH_SCRIBBLE =
  "M84 668 C 130 620, 170 700, 216 660 C 262 620, 300 706, 348 664 C 396 622, 432 700, 478 656 C 492 642, 506 636, 518 640";

export function AuthBoard() {
  const ref = useRef<SVGSVGElement>(null);
  useReducedMotion(ref, "translate(518,640)");
  return (
    <>
      <div className="ln-dotgrid pointer-events-none absolute inset-0" />
      <Toolbar />
      <svg ref={ref} viewBox="0 0 600 760" preserveAspectRatio="xMidYMid slice" className="absolute inset-0 h-full w-full">
        <path d="M76 132 C 140 126, 220 130, 296 127 C 301 128, 303 131, 302 136 C 306 190, 303 236, 307 284 C 307 290, 304 293, 298 293 C 228 297, 148 294, 82 298 C 76 298, 73 295, 74 289 C 70 238, 75 184, 71 138 C 70 133, 72 132, 76 132 Z"
          fill="none" stroke="rgba(228,236,226,.5)" strokeWidth="2" strokeLinecap="round" />
        <text x="100" y="118" fontSize="22" className="ln-hand-label">homepage v2</text>

        <path d="M312 302 C 348 334, 358 372, 370 410" fill="none" stroke="#a6ff5e" strokeWidth="2.4" strokeLinecap="round" opacity=".9" />
        <path d="M358.5 399 L 370 410 L 373 394.5" fill="none" stroke="#a6ff5e" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" opacity=".9" />

        <path d="M165 492 C 168 452, 230 422, 304 424 C 380 426, 438 458, 436 494 C 434 532, 368 560, 296 558 C 222 556, 162 530, 165 492 Z"
          fill="none" stroke="rgba(170,184,255,.55)" strokeWidth="2" strokeLinecap="round" />
        <text x="262" y="500" fontSize="24" className="ln-hand-label">user flow</text>

        <path d={AUTH_SCRIBBLE} pathLength={100} className="ln-scribble" fill="none" stroke="#a6ff5e" strokeWidth="2.6" strokeLinecap="round" />

        <g className="ln-mira-g">
          <Cursor name="Mira" color="#a6ff5e" ink="#0b1206" chipWidth={50}>
            <animateMotion className="smil" dur="11s" repeatCount="indefinite" calcMode="linear"
              keyPoints="0;1;1;0;0" keyTimes="0;0.4;0.74;0.78;1" path={AUTH_SCRIBBLE} />
            <animate className="smil" attributeName="opacity" dur="11s" repeatCount="indefinite" calcMode="linear"
              values="1;1;1;0;0;1" keyTimes="0;0.4;0.7;0.74;0.95;1" />
          </Cursor>
        </g>
        <g className="ln-cursor-dev"><Cursor name="Dev" color="#aab8ff" ink="#10131f" /></g>
        <g className="ln-cursor-ana"><Cursor name="Ana" color="#ffd479" ink="#211806" /></g>
      </svg>
      <div className="ln-sticky right-[12%] top-[20%] hidden sm:block">ship it ✦</div>
      <Presence />
    </>
  );
}

/* ============================================================
   LANDING BOARD — "team at work" scene
   Flowchart (client → api → postgres), Mira circling the DB node,
   Dev dragging a kanban card from doing → done, Ana dropping a comment.
   ============================================================ */
const HL_PATH =
  "M525 242 C 528 212, 568 190, 618 192 C 670 194, 712 216, 710 244 C 708 272, 664 292, 614 290 C 564 288, 522 270, 525 242 Z";

function Node({ d, label, lx, ly }: { d: string; label: string; lx: number; ly: number }) {
  return (
    <>
      <path d={d} fill="none" stroke="rgba(228,236,226,.5)" strokeWidth="2" strokeLinecap="round" />
      <text x={lx} y={ly} fontSize="22" textAnchor="middle" className="ln-hand-label">{label}</text>
    </>
  );
}

export function LandingBoard() {
  const panelRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<SVGSVGElement>(null);
  useReducedMotion(boardRef, "translate(525,242)");

  useEffect(() => {
    const panel = panelRef.current;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!panel || !window.matchMedia("(pointer: fine)").matches) return;
    const onMove = (e: PointerEvent) => {
      if (reduced.matches) return;
      const r = panel.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      panel.style.transform =
        "perspective(1400px) rotateX(" + (-y * 2.4).toFixed(2) + "deg) rotateY(" + (x * 2.4).toFixed(2) + "deg)";
    };
    const onLeave = () => { panel.style.transform = ""; };
    panel.addEventListener("pointermove", onMove);
    panel.addEventListener("pointerleave", onLeave);
    return () => {
      panel.removeEventListener("pointermove", onMove);
      panel.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  return (
    <div ref={panelRef} className="ln-panel relative mx-auto mt-14 w-full max-w-6xl overflow-hidden rounded-3xl transition-transform duration-300 ease-out" aria-hidden="true">
      <div className="ln-dotgrid pointer-events-none absolute inset-0" />
      <Toolbar />

      <svg ref={boardRef} viewBox="0 0 1000 560" preserveAspectRatio="xMidYMid slice" className="block w-full" style={{ height: "min(62vw, 600px)" }}>
        {/* ---- architecture flowchart ---- */}
        <Node lx={167} ly={250} label="client"
          d="M94 214 C 140 210, 190 212, 236 210 C 241 211, 243 213, 243 218 C 245 232, 243 252, 245 266 C 245 271, 242 273, 238 273 C 192 276, 140 274, 96 277 C 92 277, 90 274, 90 270 C 88 252, 92 232, 89 218 C 89 215, 91 214, 94 214 Z" />
        <Node lx={397} ly={244} label="api"
          d="M324 204 C 372 200, 424 202, 466 200 C 471 201, 473 203, 473 208 C 475 226, 473 248, 475 264 C 475 269, 472 271, 468 271 C 422 274, 370 272, 326 275 C 322 275, 320 272, 320 268 C 318 248, 322 226, 319 208 C 319 205, 321 204, 324 204 Z" />
        <Node lx={617} ly={247} label="postgres"
          d="M554 210 C 594 206, 638 208, 676 206 C 681 207, 683 209, 683 214 C 685 230, 683 250, 685 264 C 685 269, 682 271, 678 271 C 638 274, 594 272, 556 275 C 552 275, 550 272, 550 268 C 548 250, 552 230, 549 214 C 549 211, 551 210, 554 210 Z" />

        {/* connectors with tangent-aligned heads */}
        <g stroke="#a6ff5e" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" opacity=".9">
          <path d="M247 242 C 272 240, 294 240, 314 238" />
          <path d="M303 245 L 314 238 L 302 233" />
          <path d="M477 240 C 502 238, 524 240, 546 238" />
          <path d="M535 245 L 546 238 L 534 233" />
        </g>

        {/* Mira circles the database node while reviewing */}
        <path d={HL_PATH} pathLength={100} className="ln-hl" fill="none" stroke="#a6ff5e" strokeWidth="2.4" strokeLinecap="round" />
        <g className="ln-mira-g">
          <Cursor name="Mira" color="#a6ff5e" ink="#0b1206" chipWidth={50}>
            <animateMotion className="smil" dur="13s" repeatCount="indefinite" calcMode="linear"
              keyPoints="0;1;1;0;0" keyTimes="0;0.3;0.6;0.64;1" path={HL_PATH} />
            <animate className="smil" attributeName="opacity" dur="13s" repeatCount="indefinite" calcMode="linear"
              values="1;1;1;0;0;1" keyTimes="0;0.3;0.56;0.6;0.95;1" />
          </Cursor>
        </g>

        {/* ---- sprint board ---- */}
        <path d="M704 64 C 786 60, 880 62, 956 60 C 961 61, 963 63, 963 68 C 965 116, 963 172, 965 218 C 965 223, 962 225, 958 225 C 878 228, 786 226, 706 229 C 702 229, 700 226, 700 222 C 698 174, 702 118, 699 68 C 699 65, 701 64, 704 64 Z"
          fill="none" stroke="rgba(228,236,226,.5)" strokeWidth="2" strokeLinecap="round" />
        <text x="702" y="48" fontSize="22" className="ln-hand-label">sprint 12</text>
        <path d="M787 70 C 788 118, 786 168, 788 218" stroke="rgba(228,236,226,.22)" strokeWidth="1.5" fill="none" />
        <path d="M874 70 C 875 118, 873 168, 875 218" stroke="rgba(228,236,226,.22)" strokeWidth="1.5" fill="none" />
        <text x="712" y="88" fontSize="16" className="ln-hand-dim">todo</text>
        <text x="799" y="88" fontSize="16" className="ln-hand-dim">doing</text>
        <text x="886" y="88" fontSize="16" className="ln-hand-dim">done</text>
        {/* static cards */}
        <g fill="rgba(255,255,255,.07)" stroke="rgba(255,255,255,.14)">
          <rect x="709" y="98" width="70" height="26" rx="6" />
          <rect x="709" y="132" width="70" height="26" rx="6" />
          <rect x="709" y="166" width="70" height="26" rx="6" />
          <rect x="796" y="98" width="70" height="26" rx="6" />
          <rect x="883" y="98" width="70" height="26" rx="6" />
        </g>
        {/* Dev drags this card doing → done */}
        <g className="ln-card-drag">
          <rect width="70" height="26" rx="6" fill="rgba(166,255,94,.10)" stroke="rgba(166,255,94,.55)" strokeWidth="1.4" />
        </g>
        <g className="ln-dev-drag"><Cursor name="Dev" color="#aab8ff" ink="#10131f" /></g>

        {/* Ana drops a comment on the api → db hop */}
        <g transform="translate(395,310)">
          <g className="ln-pop">
            <rect width="158" height="36" rx="18" fill="rgba(14,18,16,.85)" stroke="rgba(166,255,94,.25)" />
            <circle cx="18" cy="18" r="10" fill="#ffd479" />
            <text x="18" y="22" textAnchor="middle" fontSize="10" fontWeight="600" fill="#211806" className="ln-chip-text">A</text>
            <text x="38" y="22.5" fontSize="12.5" fill="#eef3ec" className="ln-chip-text" fontWeight="500">cache this hop?</text>
          </g>
        </g>
        <g className="ln-ana2"><Cursor name="Ana" color="#ffd479" ink="#211806" /></g>
      </svg>

      <div className="ln-sticky bottom-[12%] left-[5%] hidden sm:block">ship friday ✦</div>
      <Presence />
    </div>
  );
}