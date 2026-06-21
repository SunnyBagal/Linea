"use client";
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import axios from "axios";
import { BACKEND_URL } from "../../config";
import { AuthShell, AuthHeading, TextField, PasswordField, PrimaryButton, SocialButtons, type SubmitState } from "@repo/ui";

export default function SignUpPage() {
  const router = useRouter();
  const [state, setState] = useState<SubmitState>("idle");
  const [error, setError] = useState("");

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setState("loading");
    setError("");
    const form = new FormData(e.currentTarget);
    const username = String(form.get("name") ?? "");   // form field "name" → backend "username"
    const email = String(form.get("email") ?? "");
    const password = String(form.get("password") ?? "");

    try {
      await axios.post(`${BACKEND_URL}/signup`, { username, email, password });
      router.push("/signin");   // signup returns userId, not a token → go sign in
    } catch (err) {
      setState("idle");
      setError(axios.isAxiosError(err) ? err.response?.data?.message ?? "Could not create account." : "Could not create account.");
    }
  }

  return (
    <AuthShell>
      <AuthHeading title="Start sketching together" sub="Free to start — your first board takes seconds." />
      <SocialButtons />
      <form noValidate onSubmit={onSubmit}>
        <TextField id="name" name="name" type="text" label="Full name" autoComplete="name" placeholder="Ada Lovelace" />
        <TextField id="email" name="email" type="email" label="Email" autoComplete="email" placeholder="you@studio.com" />
        <PasswordField id="password" name="password" label="Password" autoComplete="new-password" placeholder="8+ characters" showStrength />
        {error && <p className="ln-fine" style={{ color: "tomato" }}>{error}</p>}
        <div className="mt-1.5"><PrimaryButton state={state}>Create account</PrimaryButton></div>
        <p className="ln-fine">By creating an account, you agree to our <a href="#">Terms of Service</a> and <a href="#">Privacy Policy</a>.</p>
      </form>
      <p className="ln-text-2 mt-5 border-t pt-4 text-center text-sm" style={{ borderColor: "var(--ln-line-soft)" }}>
        Already have an account?{" "}<Link href="/signin" className="ln-link ln-link-accent">Sign in</Link>
      </p>
    </AuthShell>
  );
}