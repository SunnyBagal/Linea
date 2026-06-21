"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import axios from "axios";
import { BACKEND_URL } from "../../config";
import { AuthShell, AuthHeading, TextField, PasswordField, PrimaryButton, SocialButtons, type SubmitState } from "@repo/ui";

export default function SignInPage() {
  const router = useRouter();
  const [state, setState] = useState<SubmitState>("idle");
  const [error, setError] = useState("");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState("loading");
    setError("");
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");

    try {
      const res = await axios.post(`${BACKEND_URL}/signin`, { email, password });
      localStorage.setItem("token", res.data.token);   // useSocket reads this exact key
      router.push("/dashboard");
    } catch (err) {
      setState("idle");
      setError(axios.isAxiosError(err) ? err.response?.data?.message ?? "Sign in failed." : "Sign in failed.");
    }
  }

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
        {error && <p className="ln-fine" style={{ color: "tomato" }}>{error}</p>}
        <PrimaryButton state={state}>Sign in</PrimaryButton>
      </form>
      <p className="ln-text-2 mt-5 border-t pt-4 text-center text-sm" style={{ borderColor: "var(--ln-line-soft)" }}>
        New to Linea?{" "}<Link href="/signup" className="ln-link ln-link-accent">Create an account</Link>
      </p>
    </AuthShell>
  );
}