"use client";
/* packages/ui/src/auth.tsx — shared auth UI. No auth logic lives here;
   pages own the submit handler (swap the demo for BetterAuth calls). */
import Link from "next/link";
import { type FormEvent, type InputHTMLAttributes, type ReactNode, useState } from "react";
import { LineaLogo } from "./logo";
import { AuthBoard } from "./board";

/* ---------------- layout shell: card left, live board right ---------------- */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="ln-bg relative flex min-h-dvh flex-col lg:grid lg:grid-cols-[minmax(460px,46%)_1fr]">
      <div className="ln-orb ln-orb-a" aria-hidden="true" />
      <main className="relative z-10 order-last flex flex-1 flex-col items-center justify-center gap-5 px-5 py-9 lg:order-first">
        <div className="ln-card ln-rise w-full max-w-[430px]">
          <Link href="/" className="mb-6 flex w-fit items-center gap-2.5">
            <LineaLogo size={32} />
            <span className="ln-display text-lg font-semibold tracking-tight">Linea</span>
          </Link>
          {children}
        </div>
        <p className="ln-text-3 text-xs">
          © 2026 Linea&nbsp;&nbsp;·&nbsp;&nbsp;<a href="#" className="ln-foot-link">Privacy</a>&nbsp;&nbsp;·&nbsp;&nbsp;<a href="#" className="ln-foot-link">Terms</a>
        </p>
      </main>
      <aside aria-hidden="true" className="ln-panel relative order-first m-3.5 h-48 overflow-hidden rounded-3xl lg:order-last lg:m-4 lg:ml-0 lg:h-auto">
        <AuthBoard />
      </aside>
    </div>
  );
}

export function AuthHeading({ title, sub }: { title: string; sub: string }) {
  return (
    <>
      <h1 className="ln-display text-[27px] font-semibold leading-tight tracking-tight">{title}</h1>
      <p className="ln-text-2 mb-6 mt-2 text-[14.5px] leading-relaxed">{sub}</p>
    </>
  );
}

/* ---------------- fields ---------------- */
type FieldProps = InputHTMLAttributes<HTMLInputElement> & { id: string; label: string };

export function TextField({ id, label, ...rest }: FieldProps) {
  return (
    <div className="mb-4">
      <label htmlFor={id} className="ln-label">{label}</label>
      <div className="relative">
        <input id={id} className="ln-input" {...rest} />
      </div>
    </div>
  );
}

const STRENGTH_TIPS = [
  "Use 8+ characters with a number and a symbol.",
  "Keep going — add a number or symbol.",
  "Getting there — mix in more variety.",
  "Almost — one more character type.",
  "Strong password.",
];

export function PasswordField({
  id, label, showStrength = false, showCapsHint = false, ...rest
}: FieldProps & { showStrength?: boolean; showCapsHint?: boolean }) {
  const [visible, setVisible] = useState(false);
  const [caps, setCaps] = useState(false);
  const [score, setScore] = useState(0);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) =>
    setCaps(e.getModifierState?.("CapsLock") ?? false);

  const onInput = (e: FormEvent<HTMLInputElement>) => {
    if (!showStrength) return;
    const v = e.currentTarget.value;
    let s = 0;
    if (v.length >= 8) s++;
    if (/[A-Z]/.test(v)) s++;
    if (/[0-9]/.test(v)) s++;
    if (/[^A-Za-z0-9]/.test(v)) s++;
    setScore(v.length === 0 ? 0 : s);
  };

  return (
    <div className="mb-4">
      <label htmlFor={id} className="ln-label">{label}</label>
      <div className="relative">
        <input
          id={id} type={visible ? "text" : "password"}
          className="ln-input ln-has-trailing"
          onKeyDown={showCapsHint ? onKey : undefined}
          onKeyUp={showCapsHint ? onKey : undefined}
          onBlur={() => setCaps(false)}
          onInput={onInput}
          {...rest}
        />
        <button
          type="button" className="ln-trailing"
          aria-pressed={visible} aria-label={visible ? "Hide password" : "Show password"}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.5 10.5 0 0 1 12 19c-6.5 0-10-7-10-7a18.4 18.4 0 0 1 5.06-5.94" /><path d="M9.9 4.24A9.9 9.9 0 0 1 12 5c6.5 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19" /><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" /><line x1="2" y1="2" x2="22" y2="22" /></svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></svg>
          )}
        </button>
      </div>
      {showCapsHint && caps && (
        <p className="ln-hint">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>
          Caps Lock is on
        </p>
      )}
      {showStrength && (
        <div className="ln-strength" data-score={score}>
          <div className="ln-bars" aria-hidden="true"><i /><i /><i /><i /></div>
          <p className="ln-tip" aria-live="polite">{STRENGTH_TIPS[score]}</p>
        </div>
      )}
    </div>
  );
}

/* ---------------- buttons ---------------- */
export type SubmitState = "idle" | "loading" | "success";

export function PrimaryButton({ state = "idle", children }: { state?: SubmitState; children: ReactNode }) {
  return (
    <button type="submit" data-state={state} disabled={state !== "idle"}
      className="ln-btn-primary ln-sheen h-[49px] w-full text-[15px]">
      <span className="ln-bl">{children}</span>
      <span className="ln-spin" aria-hidden="true"><i /></span>
      <span className="ln-tick" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0b1206" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4.2 4.2L19 7" /></svg>
      </span>
    </button>
  );
}

export function SocialButtons() {
  return (
    <>
      <div className="mb-5 grid grid-cols-2 gap-2.5">
        <button type="button" className="ln-btn-social">
          <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true">
            <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.616z" />
            <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" />
            <path fill="#FBBC05" d="M3.964 10.706A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.706V4.962H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.038l3.007-2.332z" />
            <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.962l3.007 2.332C4.672 5.163 6.656 3.58 9 3.58z" />
          </svg>
          Google
        </button>
        <button type="button" className="ln-btn-social">
          <svg width="17" height="17" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
          </svg>
          GitHub
        </button>
      </div>
      <div className="ln-divider" aria-hidden="true">or</div>
    </>
  );
}

/* ---------------- toast + demo submit ----------------
   Replace useDemoSubmit with your BetterAuth client, e.g.:
     const router = useRouter();
     await authClient.signIn.email({ email, password });
     router.push("/dashboard");
*/
export function Toast({ open, message }: { open: boolean; message: string }) {
  return (
    <div className="ln-toast" data-open={open} role="status" aria-live="polite">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#a6ff5e" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" opacity=".35" /><path d="M8 12.5l2.8 2.8L16.5 9.5" /></svg>
      <span>{message}</span>
    </div>
  );
}

export function useDemoSubmit(message = "UI demo — wire this up to BetterAuth.") {
  const [state, setState] = useState<SubmitState>("idle");
  const [toastOpen, setToastOpen] = useState(false);

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (state !== "idle") return;
    setState("loading");
    setTimeout(() => {
      setState("success");
      setToastOpen(true);
      setTimeout(() => setState("idle"), 1500);
      setTimeout(() => setToastOpen(false), 3400);
    }, 1300);
  };

  return { state, onSubmit, toast: <Toast open={toastOpen} message={message} /> };
}