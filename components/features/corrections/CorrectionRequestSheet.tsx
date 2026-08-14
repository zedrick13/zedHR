"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/callRpc";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import styles from "./CorrectionRequestSheet.module.css";

type RequestType = "clock_in" | "clock_out" | "cb_start" | "cb_end" | "lb_start" | "lb_end" | "create_session";

const REQUEST_TYPE_LABELS: Record<RequestType, string> = {
  clock_in: "Clock-in time",
  clock_out: "Clock-out time",
  cb_start: "Break start time",
  cb_end: "Break end time",
  lb_start: "Lunch start time",
  lb_end: "Lunch end time",
  create_session: "Missing shift (clock-in)",
};

export function CorrectionRequestSheet({
  workSessionId,
  allowedTypes,
  onClose,
}: {
  workSessionId: string | null;
  allowedTypes: RequestType[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [requestType, setRequestType] = useState<RequestType>(allowedTypes[0]);
  const [timestamp, setTimestamp] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const supabase = createClient();
    const { error: rpcError } = await callRpc(supabase, "submit_correction_request", {
      p_work_session_id: requestType === "create_session" ? null : workSessionId,
      p_request_type: requestType,
      p_requested_timestamp: new Date(timestamp).toISOString(),
      p_reason: reason,
    });

    if (rpcError) {
      setError(rpcError.message);
      setIsSubmitting(false);
      return;
    }

    router.refresh();
    onClose();
  }

  return (
    <Sheet>
      <h2 className={styles.title}>Request a correction</h2>
      <form className={styles.form} onSubmit={handleSubmit}>
        <label className={styles.selectLabel}>
          What needs fixing?
          <select
            className={styles.select}
            value={requestType}
            onChange={(e) => setRequestType(e.target.value as RequestType)}
          >
            {allowedTypes.map((type) => (
              <option key={type} value={type}>
                {REQUEST_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </label>
        <TextField
          label="Correct time"
          type="datetime-local"
          required
          value={timestamp}
          onChange={(e) => setTimestamp(e.target.value)}
        />
        <TextField
          label="Reason"
          required
          minLength={1}
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Submitting…" : "Submit request"}
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
