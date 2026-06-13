"use client";
/* apps/web/app/page.tsx — Linea landing */
import Link from "next/link";
import { type ReactNode } from "react";
import { LineaLogo, LandingBoard } from "@repo/ui";

export default function LandingPage() {
  return (
    <div className="ln-bg relative min-h-screen overflow-hidden antialiased">
      <div className="ln-orb ln-orb-a" aria-hidden="true" />
      <div className="ln-orb ln-orb-b" aria-hidden="true" />

      {/* ================= NAV ================= */}
      <header className="relative z-10 mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2.5">
          <LineaLogo size={32} />
          <span className="ln-display text-lg font-semibold tracking-tight">Linea</span>
        </Link>
        <nav className="flex items-center gap-2">
          <Link href="/signin" className="ln-btn-ghost rounded-xl px-4 py-2 text-sm font-medium">Sign in</Link>
          <Link href="/signup" className="ln-btn-primary rounded-xl px-4 py-2 text-sm font-semibold">Get started</Link>
        </nav>
      </header>

      {/* ================= HERO ================= */}
      <main className="relative z-10 mx-auto max-w-7xl px-6 pb-20 pt-14 text-center md:pt-20">
        <div className="ln-rise" style={{ animationDelay: "0ms" }}>
          <span className="ln-glass ln-text-2 inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-medium">
            <span className="ln-pulse-dot" />
            Now in public beta
          </span>
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
          Linea is the collaborative whiteboard for fast-moving teams. Sketch, point, and decide together — in real time, in your browser.
        </p>

        <div className="ln-rise mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row" style={{ animationDelay: "270ms" }}>
          <Link href="/signup" className="ln-btn-primary ln-sheen relative w-full overflow-hidden rounded-xl px-7 py-3.5 text-base sm:w-auto">
            Get started
          </Link>
          <Link href="/signin" className="ln-btn-ghost w-full rounded-xl px-7 py-3.5 text-base font-medium sm:w-auto">
            Sign in
          </Link>
        </div>

        <p className="ln-text-3 ln-rise mt-4 text-xs" style={{ animationDelay: "340ms" }}>
          Free for small teams · No credit card required
        </p>

        {/* ================= LIVE BOARD (bigger, working-session scene) ================= */}
        <div className="ln-rise" style={{ animationDelay: "420ms" }}>
          <LandingBoard />
        </div>

        {/* ================= FEATURE CARDS ================= */}
        <section className="mx-auto mt-20 grid max-w-5xl gap-5 sm:grid-cols-3">
          <FeatureCard
            title="Real-time cursors"
            body="Every pointer is live. Watch teammates sketch, point, and react the moment it happens — like standing at the same whiteboard."
            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M4 3l7.5 18 2.4-7.1L21 11.5 4 3z" /></svg>}
          />
          <FeatureCard
            title="Infinite canvas"
            body="Zoom out and the board keeps going. Architecture diagrams, sprint boards, and scribbles — all in one endless space."
            icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6" /><path d="M9 21H3v-6" /><path d="M21 3l-7 7" /><path d="M3 21l7-7" /></svg>}
          />
          <FeatureCard
            title="Hand-drawn feel"
            body="Strokes with personality, not pixel-perfect noise. Rough edges keep ideas feeling early — so people keep iterating."
            icon={<svg width="18" height="18" viewBox="0 0 22 18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M2 13 C5 4, 9 4, 11 9 C13 14, 17 14, 20 5" /></svg>}
          />
        </section>
      </main>

      {/* ================= FOOTER ================= */}
      <footer className="relative z-10 mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-6 py-8 sm:flex-row">
        <div className="flex items-center gap-2">
          <LineaLogo size={22} />
          <span className="ln-text-3 text-xs">© 2026 Linea</span>
        </div>
        <div className="ln-text-3 flex gap-6 text-xs">
          <a href="#" className="ln-foot-link">Privacy</a>
          <a href="#" className="ln-foot-link">Terms</a>
          <a href="#" className="ln-foot-link">Contact</a>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="ln-feature-card">
      <span className="ln-icon-tile mb-4">{icon}</span>
      <h3 className="text-[15px] font-semibold">{title}</h3>
      <p className="ln-text-2 mt-2 text-sm leading-relaxed">{body}</p>
    </div>
  );
}