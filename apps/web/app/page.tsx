"use client";
/* apps/web/app/page.tsx — Linea landing v3 */
import Link from "next/link";
import { type ReactNode, useEffect, useRef } from "react";
import { LineaLogo, LandingBoard } from "@repo/ui";

/* Scroll-reveal wrapper: fades sections in as they enter the viewport. */
function Reveal({ children, className = "", delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting) {
          el.classList.add("ln-in");
          io.disconnect();
        }
      },
      { threshold: 0.15 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className={"ln-reveal " + className} style={delay ? { transitionDelay: delay + "ms" } : undefined}>
      {children}
    </div>
  );
}

export default function LandingPage() {
  return (
    <div className="ln-bg relative min-h-screen overflow-hidden antialiased">
      <div className="ln-orb ln-orb-a" aria-hidden="true" />
      <div className="ln-orb ln-orb-b" aria-hidden="true" />

      {/* ================= NAV ================= */}
      <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Link href="/" className="flex items-center gap-3">
          <LineaLogo size={40} />
          <span className="ln-display text-[22px] font-semibold tracking-tight">Linea</span>
        </Link>
        <nav className="flex items-center gap-7">
          <div className="ln-text-2 hidden items-center gap-7 text-sm font-medium md:flex">
            <a href="#product" className="ln-foot-link">Product</a>
            <a href="#how" className="ln-foot-link">How it works</a>
            <a href="#faq" className="ln-foot-link">FAQ</a>
          </div>
          <Link href="/signin" className="ln-btn-ghost rounded-xl px-4 py-2 text-sm font-medium">Sign in</Link>
        </nav>
      </header>

      {/* ================= HERO ================= */}
      <main className="relative z-10 mx-auto max-w-7xl px-6 text-center">
        <section className="pt-14 md:pt-20">
          <div className="ln-rise" style={{ animationDelay: "0ms" }}>
            {/* point this at your repo */}
            <a
              href="https://github.com/sunnybagal/graphite"
              target="_blank"
              rel="noreferrer"
              className="ln-glass ln-text-2 inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-medium"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
              </svg>
              Open source on GitHub
            </a>
          </div>

          <h1 className="ln-display ln-rise mx-auto mt-7 max-w-3xl text-5xl font-semibold leading-tight tracking-tight md:text-7xl" style={{ animationDelay: "90ms" }}>
            Where ideas take{" "}
            <span className="relative inline-block">
              <span className="ln-hand ln-accent">shape</span>
              <svg viewBox="0 0 120 12" className="absolute -bottom-2 left-0 w-full" aria-hidden="true" preserveAspectRatio="none">
                <path d="M3 9 C 25 3, 45 11, 65 6 C 85 1, 102 8, 117 4" fill="none" stroke="#a6ff5e" strokeWidth="3" strokeLinecap="round" opacity=".85" />
              </svg>
            </span>
          </h1>

          <p className="ln-text-2 ln-rise mx-auto mt-6 max-w-xl text-base leading-relaxed md:text-lg" style={{ animationDelay: "180ms" }}>
            Linea is the collaborative whiteboard for fast-moving teams. Sketch, point, and decide together in real time, right in your browser.
          </p>

          <div className="ln-rise mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row" style={{ animationDelay: "270ms" }}>
            <Link href="/signup" className="ln-btn-primary ln-sheen relative w-full overflow-hidden rounded-xl px-7 py-3.5 text-base sm:w-auto">
              Get started
            </Link>
            <a href="#product" className="ln-btn-ghost w-full rounded-xl px-7 py-3.5 text-base font-medium sm:w-auto">
              See it in action
            </a>
          </div>

          <p className="ln-text-3 ln-rise mt-4 text-xs" style={{ animationDelay: "340ms" }}>
            Built with Next.js, WebSockets, and PostgreSQL
          </p>
        </section>

        {/* ================= LIVE BOARD ================= */}
        <section id="product" className="ln-rise scroll-mt-24" style={{ animationDelay: "420ms" }}>
          <LandingBoard />
        </section>

        {/* ================= FEATURES ================= */}
        <section className="mx-auto max-w-5xl pt-28">
          <Reveal>
            <span className="ln-hand ln-accent text-2xl">why linea</span>
            <h2 className="ln-display mt-2 text-3xl font-semibold tracking-tight md:text-5xl">Made for thinking together</h2>
          </Reveal>
          <div className="mt-12 grid gap-5 sm:grid-cols-3">
            <Reveal delay={0}>
              <FeatureCard
                title="Real-time cursors"
                body="Every pointer is live. Watch teammates sketch, point, and react the moment it happens, like standing at the same whiteboard."
                icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M4 3l7.5 18 2.4-7.1L21 11.5 4 3z" /></svg>}
              />
            </Reveal>
            <Reveal delay={90}>
              <FeatureCard
                title="Infinite canvas"
                body="Zoom out and the board keeps going. Architecture diagrams, sprint boards, and scribbles all live in one endless space."
                icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" /></svg>}
              />
            </Reveal>
            <Reveal delay={180}>
              <FeatureCard
                title="Hand-drawn feel"
                body="Strokes with personality, not pixel-perfect noise. Rough edges keep ideas feeling early, so people keep iterating."
                icon={<svg width="18" height="18" viewBox="0 0 22 18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M2 13 C5 4, 9 4, 11 9 C13 14, 17 14, 20 5" /></svg>}
              />
            </Reveal>
          </div>
        </section>

        {/* ================= HOW IT WORKS ================= */}
        <section id="how" className="mx-auto max-w-5xl scroll-mt-24 pt-28">
          <Reveal>
            <span className="ln-hand ln-accent text-2xl">how it works</span>
            <h2 className="ln-display mt-2 text-3xl font-semibold tracking-tight md:text-5xl">From blank to decided in minutes</h2>
          </Reveal>
          <div className="mt-12">
            <Step n="01" title="Create a board" body="One click, no setup. A fresh canvas with a dot grid and your team's name on it." />
            <Step n="02" title="Share the link" body="Teammates open the link, sign in, and land on your canvas. Everyone sees the same board, live." />
            <Step n="03" title="Think out loud" body="Sketch flows, drag cards, drop comments, and vote. Decisions happen on the board, not in a thread." />
          </div>
        </section>

        {/* ================= TIME TRAVEL ================= */}
        <section className="mx-auto max-w-6xl pt-28">
          <div className="grid items-center gap-12 text-left lg:grid-cols-2">
            <Reveal>
              <span className="ln-hand ln-accent text-2xl">time travel</span>
              <h2 className="ln-display mt-2 text-3xl font-semibold tracking-tight md:text-5xl">Every stroke, replayed</h2>
              <p className="ln-text-2 mt-5 max-w-md text-[15px] leading-relaxed">
                Linea records every action on an append-only operation log. Scrub back to any moment and watch the board rebuild itself, stroke by stroke.
              </p>
              <ul className="mt-7 space-y-3.5">
                <Check>Undo that never lies, even mid-collaboration</Check>
                <Check>Jump to any point in the board&apos;s history</Check>
                <Check>Watch how a decision actually happened</Check>
              </ul>
            </Reveal>
            <Reveal delay={120}>
              <div className="ln-panel relative overflow-hidden rounded-3xl" aria-hidden="true">
                <div className="ln-dotgrid pointer-events-none absolute inset-0" />
                <svg viewBox="0 0 360 220" className="block w-full">
                  <text x="26" y="40" fontSize="20" className="ln-hand-label">replaying session…</text>
                  {/* a shape re-drawing itself */}
                  <path d="M60 110 C 100 74, 140 132, 180 96 C 220 60, 260 130, 300 92" pathLength={100} className="ln-scribble" fill="none" stroke="#a6ff5e" strokeWidth="2.4" strokeLinecap="round" />
                  {/* timeline */}
                  <line x1="40" y1="176" x2="320" y2="176" stroke="rgba(255,255,255,.14)" strokeWidth="2" strokeLinecap="round" />
                  {[40, 80, 120, 160, 200, 240, 280, 320].map((x) => (
                    <circle key={x} cx={x} cy="176" r="3" fill="rgba(255,255,255,.22)" />
                  ))}
                  <g className="ln-playhead">
                    <line x1="52" y1="160" x2="52" y2="192" stroke="#a6ff5e" strokeWidth="2" strokeLinecap="round" />
                    <circle cx="52" cy="176" r="7" fill="#a6ff5e" />
                  </g>
                </svg>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ================= ON THE BOARDS ================= */}
        <section className="mx-auto max-w-5xl pt-28">
          <Reveal>
            <span className="ln-hand ln-accent text-2xl">on the boards</span>
            <h2 className="ln-display mt-2 text-3xl font-semibold tracking-tight md:text-5xl">One canvas, every ritual</h2>
          </Reveal>
          <div className="mt-14 flex flex-wrap items-start justify-center gap-8">
            <Reveal delay={0}>
              <div className="ln-note" style={{ transform: "rotate(-3deg)" }}>
                retro: what went well? ✦
                <small>friday team ritual</small>
              </div>
            </Reveal>
            <Reveal delay={100}>
              <div className="ln-note" style={{ transform: "rotate(2deg)" }}>
                payments flow v3 →
                <small>architecture review</small>
              </div>
            </Reveal>
            <Reveal delay={200}>
              <div className="ln-note" style={{ transform: "rotate(-1.5deg)" }}>
                design a URL shortener
                <small>interview practice</small>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ================= FAQ ================= */}
        <section id="faq" className="ln-faq mx-auto max-w-3xl scroll-mt-24 pt-28 text-left">
          <Reveal className="text-center">
            <span className="ln-hand ln-accent text-2xl">questions</span>
            <h2 className="ln-display mt-2 text-3xl font-semibold tracking-tight md:text-5xl">Good ones, answered</h2>
          </Reveal>
          <Reveal delay={100}>
            <div className="mt-12 space-y-3.5">
              <details>
                <summary>Do I need an account?</summary>
                <div className="ln-faq-body">Yes. Boards live in your workspace, so sign-up comes first. It takes a few seconds, and your work stays synced across devices.</div>
              </details>
              <details>
                <summary>How does time travel work?</summary>
                <div className="ln-faq-body">Every action is an operation on an append-only log. Replaying that log up to any point rebuilds the exact board state, which is also what keeps undo and live sync consistent. Replay is read-only, so history is never rewritten.</div>
              </details>
              <details>
                <summary>Does it work on tablets and phones?</summary>
                <div className="ln-faq-body">Yes. Boards are fully responsive, and drawing works with touch and stylus input.</div>
              </details>
              <details>
                <summary>Is Linea open source?</summary>
                <div className="ln-faq-body">Yes. The whole monorepo is on GitHub: a Next.js frontend, a Node HTTP API, and a WebSocket server, all backed by PostgreSQL.</div>
              </details>
            </div>
          </Reveal>
        </section>

        {/* ================= FINAL CTA ================= */}
        <section className="pb-32 pt-28">
          <Reveal>
            <LineaLogo size={52} className="mx-auto" />
            <h2 className="ln-display mx-auto mt-7 max-w-2xl text-4xl font-semibold tracking-tight md:text-6xl">
              Ready to think <span className="ln-hand ln-accent">out loud</span>
            </h2>
            <p className="ln-text-2 mx-auto mt-5 max-w-md text-[15px] leading-relaxed">
              Spin up a board and invite your team. It takes less time than reading this sentence.
            </p>
            <div className="mt-9">
              <Link href="/signup" className="ln-btn-primary ln-sheen relative inline-block overflow-hidden rounded-xl px-8 py-4 text-base">
                Create your first board
              </Link>
            </div>
            <p className="ln-text-3 mt-4 text-xs">Developed by Sunny Bagal</p>
          </Reveal>
        </section>
      </main>
    </div>
  );
}

function FeatureCard({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="ln-feature-card h-full">
      <span className="ln-icon-tile mb-4">{icon}</span>
      <h3 className="text-[15px] font-semibold">{title}</h3>
      <p className="ln-text-2 mt-2 text-sm leading-relaxed">{body}</p>
    </div>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <Reveal>
      <div className="group flex flex-col gap-2 border-t py-9 text-left md:flex-row md:items-baseline md:gap-10" style={{ borderColor: "var(--ln-line-soft)" }}>
        <span className="ln-hand ln-accent text-4xl transition-transform duration-300 group-hover:translate-x-1 md:w-20">{n}</span>
        <h3 className="ln-display text-xl font-semibold md:w-72">{title}</h3>
        <p className="ln-text-2 max-w-md text-[15px] leading-relaxed">{body}</p>
      </div>
    </Reveal>
  );
}

function Check({ children }: { children: ReactNode }) {
  return (
    <li className="ln-text-2 flex items-start gap-3 text-[15px]">
      <svg className="mt-0.5 flex-none" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#a6ff5e" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" opacity=".3" />
        <path d="M8 12.5l2.8 2.8L16.5 9.5" />
      </svg>
      {children}
    </li>
  );
}