"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { AuthCard } from "@/components/features/auth/AuthCard";
import { TextField } from "@/components/ui/TextField";
import { Button } from "@/components/ui/Button";
import styles from "./page.module.css";

type Step = "loading" | "verify" | "backup-codes" | "error";

export default function MfaEnrollPage() {
  const [step, setStep] = useState<Step>("loading");
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [acknowledged, setAcknowledged] = useState(false);
  const hasEnrolledRef = useRef(false);

  useEffect(() => {
    // Guards against React Strict Mode's dev-only double-invoke, which
    // would otherwise enroll two factors and leave the DOM/challenge
    // pointed at inconsistent state.
    if (hasEnrolledRef.current) return;
    hasEnrolledRef.current = true;

    const supabase = createClient();
    supabase.auth.mfa.enroll({ factorType: "totp" }).then(({ data, error: enrollError }) => {
      if (enrollError || !data) {
        setError("Couldn't start MFA setup. Please try again.");
        setStep("error");
        return;
      }
      setFactorId(data.id);
      setQrCode(data.totp.qr_code);
      setSecret(data.totp.secret);
      setStep("verify");
    });
  }, []);

  async function handleVerify(event: FormEvent) {
    event.preventDefault();
    if (!factorId) return;
    setError(null);
    setIsSubmitting(true);

    const supabase = createClient();
    const { data: challenge, error: challengeError } = await supabase.auth.mfa.challenge({
      factorId,
    });
    if (challengeError || !challenge) {
      setError("Couldn't verify that code. Please try again.");
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

    const { data: codes, error: codesError } = await supabase.rpc("generate_mfa_backup_codes");
    if (codesError || !codes) {
      setError("MFA was verified but backup codes couldn't be generated. Please contact an admin.");
      setStep("error");
      setIsSubmitting(false);
      return;
    }

    setBackupCodes(codes);
    setStep("backup-codes");
    setIsSubmitting(false);
  }

  function handleContinue() {
    // Hard navigation: see the note in login/LoginForm.tsx.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/";
  }

  if (step === "loading") {
    return (
      <AuthCard title="Setting up two-factor authentication">
        <p>Loading…</p>
      </AuthCard>
    );
  }

  if (step === "error") {
    return (
      <AuthCard title="Something went wrong">
        <p role="alert" className={styles.error}>
          {error}
        </p>
      </AuthCard>
    );
  }

  if (step === "backup-codes") {
    return (
      <AuthCard
        title="Save your backup codes"
        subtitle="Each code can be used once if you lose access to your authenticator app"
      >
        <ul className={styles.codeList}>
          {backupCodes.map((backupCode) => (
            <li key={backupCode} className={styles.code}>
              {backupCode}
            </li>
          ))}
        </ul>
        <label className={styles.checkboxRow}>
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          I&rsquo;ve saved these codes somewhere safe
        </label>
        <Button onClick={handleContinue} disabled={!acknowledged}>
          Continue
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Set up two-factor authentication"
      subtitle="Scan this QR code with your authenticator app"
    >
      {qrCode && (
        // eslint-disable-next-line @next/next/no-img-element -- qr_code is a data: URI, not an optimizable remote asset
        <img src={qrCode} alt="TOTP QR code" className={styles.qr} />
      )}
      {secret && (
        <p className={styles.secret}>
          Can&rsquo;t scan? Enter this code manually: <code>{secret}</code>
        </p>
      )}
      <form className={styles.form} onSubmit={handleVerify}>
        <TextField
          label="6-digit code"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
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
      </form>
    </AuthCard>
  );
}
