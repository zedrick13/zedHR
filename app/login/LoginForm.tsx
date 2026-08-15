"use client";

import { useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { AuthCard } from "@/components/features/auth/AuthCard";
import { TextField } from "@/components/ui/TextField";
import { Button } from "@/components/ui/Button";
import styles from "./page.module.css";

function safeRedirectTarget(raw: string | null): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) {
    return raw;
  }
  return "/";
}

export function LoginForm() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const supabase = createClient();

    const { error: rateLimitError } = await supabase.rpc("check_login_allowed", {
      p_email: email,
    });
    if (rateLimitError) {
      setError("Too many attempts. Please wait 15 minutes and try again.");
      setIsSubmitting(false);
      return;
    }

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (signInError) {
      await supabase.rpc("record_login_failure", { p_email: email });
      setError("Invalid email or password.");
      setIsSubmitting(false);
      return;
    }

    // Hard navigation, not router.push: middleware must re-evaluate against
    // the just-established session, and a client-side transition can be
    // served from a stale prefetch cache that predates sign-in.
    window.location.href = safeRedirectTarget(searchParams.get("redirect"));
  }

  return (
    <AuthCard title="zedHR" subtitle="Sign in to continue">
      <form className={styles.form} onSubmit={handleSubmit}>
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Signing in…" : "Sign in"}
        </Button>
        <a className={styles.forgotLink} href="/forgot-password">
          Forgot password?
        </a>
      </form>
    </AuthCard>
  );
}
