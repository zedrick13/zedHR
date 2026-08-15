"use client";

import { useEffect, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { AuthCard } from "@/components/features/auth/AuthCard";
import { TextField } from "@/components/ui/TextField";
import { Button } from "@/components/ui/Button";
import styles from "./page.module.css";

export default function MfaChallengePage() {
  const [mode, setMode] = useState<"totp" | "backup">("totp");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.mfa.listFactors().then(({ data, error: listError }) => {
      const totpFactor = data?.totp.find((f) => f.status === "verified");
      if (listError || !totpFactor) {
        setError("No verified authenticator found. Please contact an admin.");
        return;
      }
      setFactorId(totpFactor.id);
    });
  }, []);

  async function handleTotpSubmit(event: FormEvent) {
    event.preventDefault();
    if (!factorId) return;
    setError(null);
    setIsSubmitting(true);

    const supabase = createClient();
    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
      factorId,
    });
    if (challengeError || !challenge) {
      setError("Something went wrong. Please try again.");
      setIsSubmitting(false);
      return;
    }

    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId,
      challengeId: challenge.id,
      code,
    });
    if (verifyError) {
      setError("That code isn't correct. Please try again.");
      setIsSubmitting(false);
      return;
    }

    // Hard navigation: see the note in login/LoginForm.tsx.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/";
  }

  async function handleBackupCodeSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const supabase = createClient();
    const { error: verifyError } = await supabase.rpc("verify_backup_code", { p_code: code });
    if (verifyError) {
      setError("That backup code isn't valid.");
      setIsSubmitting(false);
      return;
    }

    // The backup-code grant only takes effect on the *next* minted token
    // (SPEC §7 / custom_access_token_hook) — refresh to pick it up.
    await supabase.auth.refreshSession();

    // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- hard navigation, see login/LoginForm.tsx
    window.location.href = "/mfa/enroll";
  }

  return (
    <AuthCard
      title="Verify it's you"
      subtitle={mode === "totp" ? "Enter the code from your authenticator app" : "Enter a backup code"}
    >
      <form
        className={styles.form}
        onSubmit={mode === "totp" ? handleTotpSubmit : handleBackupCodeSubmit}
      >
        <TextField
          label={mode === "totp" ? "6-digit code" : "Backup code"}
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Verifying…" : "Verify"}
        </Button>
        <button
          type="button"
          className={styles.toggle}
          onClick={() => {
            setMode(mode === "totp" ? "backup" : "totp");
            setCode("");
            setError(null);
          }}
        >
          {mode === "totp" ? "Use a backup code instead" : "Use my authenticator app instead"}
        </button>
      </form>
    </AuthCard>
  );
}
