"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/callRpc";
import { TextField } from "@/components/ui/TextField";
import { Button } from "@/components/ui/Button";
import styles from "./AdminTimecardEditForm.module.css";

export function AdminTimecardEditForm() {
  const router = useRouter();
  const [sessionId, setSessionId] = useState("");
  const [clockIn, setClockIn] = useState("");
  const [clockOut, setClockOut] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(false);
    setIsSubmitting(true);

    const supabase = createClient();
    const { error: rpcError } = await callRpc(supabase, "admin_edit_locked_timecard", {
      p_session_id: sessionId,
      p_clock_in: new Date(clockIn).toISOString(),
      p_clock_out: clockOut ? new Date(clockOut).toISOString() : null,
      p_reason: reason,
    });

    if (rpcError) {
      setError(rpcError.message);
      setIsSubmitting(false);
      return;
    }

    setSuccess(true);
    setIsSubmitting(false);
    router.refresh();
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <TextField
        label="Work session ID"
        required
        value={sessionId}
        onChange={(e) => setSessionId(e.target.value)}
      />
      <TextField
        label="Clock in"
        type="datetime-local"
        required
        value={clockIn}
        onChange={(e) => setClockIn(e.target.value)}
      />
      <TextField
        label="Clock out (leave blank if still open)"
        type="datetime-local"
        value={clockOut}
        onChange={(e) => setClockOut(e.target.value)}
      />
      <TextField label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} />
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {success && <p className={styles.success}>Timecard updated.</p>}
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
