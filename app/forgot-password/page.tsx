"use client";

import { useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { AuthCard } from "@/components/features/auth/AuthCard";
import { TextField } from "@/components/ui/TextField";
import { Button } from "@/components/ui/Button";
import styles from "./page.module.css";

// SPEC §7: generic response regardless of whether the email exists, so the
// form never reveals account existence.
const GENERIC_MESSAGE =
  "If that email address is registered, we've sent a link to reset your password.";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setIsSubmitting(true);

    const supabase = createClient();
    const { error: rateLimitError } = await supabase.rpc("check_password_reset_allowed", {
      p_email: email,
    });

    if (!rateLimitError) {
      await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`,
      });
    }

    // Generic response either way (rate-limited or not) — never leak which.
    setSubmitted(true);
    setIsSubmitting(false);
  }

  return (
    <AuthCard title="Reset password" subtitle="We'll email you a reset link">
      {submitted ? (
        <p className={styles.message}>{GENERIC_MESSAGE}</p>
      ) : (
        <form className={styles.form} onSubmit={handleSubmit}>
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Sending…" : "Send reset link"}
          </Button>
          <a className={styles.backLink} href="/login">
            Back to sign in
          </a>
        </form>
      )}
    </AuthCard>
  );
}
