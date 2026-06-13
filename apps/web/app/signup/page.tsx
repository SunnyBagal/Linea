"use client";
/* apps/web/app/signup/page.tsx */
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AuthShell, AuthHeading, TextField, PasswordField,
  PrimaryButton, SocialButtons, useDemoSubmit,
} from "@repo/ui";

export default function SignUpPage() {
  const router = useRouter();
  const { state, onSubmit, toast } = useDemoSubmit();
  // With BetterAuth: await authClient.signUp.email({ name, email, password })
  // then router.push("/dashboard"). router is imported and ready.
  void router;

  return (
    <AuthShell>
      <AuthHeading title="Start sketching together" sub="Free to start — your first board takes seconds." />
      <SocialButtons />

      <form noValidate onSubmit={onSubmit}>
        <TextField id="name" name="name" type="text" label="Full name" autoComplete="name" placeholder="Ada Lovelace" />
        <TextField id="email" name="email" type="email" label="Email" autoComplete="email" placeholder="you@studio.com" />
        <PasswordField id="password" name="password" label="Password" autoComplete="new-password" placeholder="8+ characters" showStrength />

        <div className="mt-1.5">
          <PrimaryButton state={state}>Create account</PrimaryButton>
        </div>
        <p className="ln-fine">
          By creating an account, you agree to our <a href="#">Terms of Service</a> and <a href="#">Privacy Policy</a>.
        </p>
      </form>

      <p className="ln-text-2 mt-5 border-t pt-4 text-center text-sm" style={{ borderColor: "var(--ln-line-soft)" }}>
        Already have an account?{" "}
        <Link href="/signin" className="ln-link ln-link-accent">Sign in</Link>
      </p>
      {toast}
    </AuthShell>
  );
}