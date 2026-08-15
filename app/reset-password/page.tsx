"use client";

import { useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { AuthCard } from "@/components/features/auth/AuthCard";
import { TextField } from "@/components/ui/TextField";
import { Button } from "@/components/ui/Button";
import { PasswordRules } from "@/components/features/auth/PasswordRules";
import { isPasswordValid } from "@/lib/passwordPolicy";
import styles from "./page.module.css";

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (!isPasswordValid(password)) {
      setError("Please meet all password requirements.");
      return;
    }

    setIsSubmitting(true);
    const supabase = createClient();

    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setError("Couldn't update your password. Your reset link may have expired.");
      setIsSubmitting(false);
      return;
    }

    await supabase.rpc("complete_password_reset");

    // Hard navigation: see the note in login/LoginForm.tsx.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/";
  }

  return (
    <AuthCard title="Set a new password">
      <form className={styles.form} onSubmit={handleSubmit}>
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <PasswordRules password={password} />
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Save password"}
        </Button>
      </form>
    </AuthCard>
  );
}
