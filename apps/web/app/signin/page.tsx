"use client";
/* apps/web/app/signin/page.tsx */
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AuthShell, AuthHeading, TextField, PasswordField,
  PrimaryButton, SocialButtons, useDemoSubmit,
} from "@repo/ui";

export default function SignInPage() {
  const router = useRouter();
  const { state, onSubmit, toast } = useDemoSubmit();
  // With BetterAuth: await authClient.signIn.email({ email, password, rememberMe })
  // then router.push("/dashboard"). router is imported and ready.
  void router;

  return (
    <AuthShell>
      <AuthHeading title="Welcome back" sub="Sign in to keep sketching with your team." />
      <SocialButtons />

      <form noValidate onSubmit={onSubmit}>
        <TextField id="email" name="email" type="email" label="Email" autoComplete="email" placeholder="you@studio.com" />
        <PasswordField id="password" name="password" label="Password" autoComplete="current-password" placeholder="••••••••" showCapsHint />

        <div className="mb-5 mt-0.5 flex items-center justify-between">
          <label className="ln-check"><input type="checkbox" name="remember" /> Remember me</label>
          <Link href="/reset" className="ln-link">Forgot password?</Link>
        </div>

        <PrimaryButton state={state}>Sign in</PrimaryButton>
      </form>

      <p className="ln-text-2 mt-5 border-t pt-4 text-center text-sm" style={{ borderColor: "var(--ln-line-soft)" }}>
        New to Linea?{" "}
        <Link href="/signup" className="ln-link ln-link-accent">Create an account</Link>
      </p>
      {toast}
    </AuthShell>
  );
}