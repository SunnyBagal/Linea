"use client";
/* apps/web/app/reset/page.tsx */
import Link from "next/link";
import { AuthShell, AuthHeading, TextField, PrimaryButton, useDemoSubmit } from "@repo/ui";

export default function ResetPage() {
  const { state, onSubmit, toast } = useDemoSubmit("UI demo — hook up your reset email flow.");
  return (
    <AuthShell>
      <Link href="/signin" className="ln-link mb-4 inline-flex items-center gap-1.5">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5" /><path d="m12 19-7-7 7-7" /></svg>
        Back to sign in
      </Link>
      <AuthHeading title="Reset your password" sub="Enter your account email and we’ll send you a reset link." />
      <form noValidate onSubmit={onSubmit}>
        <TextField id="email" name="email" type="email" label="Email" autoComplete="email" placeholder="you@studio.com" />
        <div className="mt-1.5"><PrimaryButton state={state}>Send reset link</PrimaryButton></div>
      </form>
      {toast}
    </AuthShell>
  );
}
