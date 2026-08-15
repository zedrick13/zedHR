"use client";

import { useParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { AuthCard } from "@/components/features/auth/AuthCard";
import { TextField } from "@/components/ui/TextField";
import { Button } from "@/components/ui/Button";
import { PasswordRules } from "@/components/features/auth/PasswordRules";
import { isPasswordValid } from "@/lib/passwordPolicy";
import styles from "./page.module.css";

export default function AcceptInvitePage() {
  const { token } = useParams<{ token: string }>();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
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

    const { error: rpcError } = await supabase.rpc("accept_invitation", {
      p_token: token,
      p_password: password,
      p_first_name: firstName,
      p_last_name: lastName,
    });

    if (rpcError) {
      if (rpcError.message === "ERR_USER_LIMIT_EXCEEDED") {
        // eslint-disable-next-line @next/next/no-location-assign-relative-destination
        window.location.href = "/limit-exceeded";
        return;
      }
      setError(inviteErrorMessage(rpcError.message));
      setIsSubmitting(false);
      return;
    }

    // Hard navigation: see the note in login/LoginForm.tsx.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/";
  }

  return (
    <AuthCard title="Welcome to zedHR" subtitle="Set your name and password to continue">
      <form className={styles.form} onSubmit={handleSubmit}>
        <TextField
          label="First name"
          required
          value={firstName}
          onChange={(e) => setFirstName(e.target.value)}
        />
        <TextField
          label="Last name"
          required
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
        />
        <TextField
          label="Password"
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
          {isSubmitting ? "Setting up your account…" : "Continue"}
        </Button>
      </form>
    </AuthCard>
  );
}

function inviteErrorMessage(code: string): string {
  switch (code) {
    case "INVITATION_NOT_FOUND":
      return "This invitation link isn't valid.";
    case "INVITATION_ALREADY_USED":
      return "This invitation has already been used.";
    case "INVITATION_REVOKED":
      return "This invitation was revoked.";
    case "INVITATION_EXPIRED":
      return "This invitation has expired. Ask your admin to send a new one.";
    case "ERR_RATE_LIMITED":
      return "Too many attempts. Please wait a few minutes and try again.";
    default:
      return "Something went wrong. Please try again.";
  }
}
