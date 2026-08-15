"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/callRpc";
import { Button } from "@/components/ui/Button";
import styles from "./CorrectionReviewRow.module.css";

const REQUEST_TYPE_LABELS: Record<string, string> = {
  clock_in: "Clock-in time",
  clock_out: "Clock-out time",
  cb_start: "Break start time",
  cb_end: "Break end time",
  lb_start: "Lunch start time",
  lb_end: "Lunch end time",
  create_session: "Missing shift",
};

type CorrectionRow = {
  id: string;
  request_type: string;
  requested_timestamp: string;
  reason: string;
  MST_User: { first_name: string; last_name: string } | null;
};

export function CorrectionReviewRow({ request }: { request: CorrectionRow }) {
  const router = useRouter();
  const [resolved, setResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showRejectNote, setShowRejectNote] = useState(false);
  const [rejectionNote, setRejectionNote] = useState("");

  async function handleApprove() {
    setIsSubmitting(true);
    setError(null);
    const supabase = createClient();
    const { error: rpcError } = await callRpc(supabase, "approve_correction_request", {
      p_correction_id: request.id,
    });
    if (rpcError) {
      setError(rpcError.message);
      setIsSubmitting(false);
      return;
    }
    setResolved(true);
    router.refresh();
  }

  async function handleReject() {
    setIsSubmitting(true);
    setError(null);
    const supabase = createClient();
    const { error: rpcError } = await callRpc(supabase, "reject_correction_request", {
      p_correction_id: request.id,
      p_rejection_note: rejectionNote || null,
    });
    if (rpcError) {
      setError(rpcError.message);
      setIsSubmitting(false);
      return;
    }
    setResolved(true);
    router.refresh();
  }

  if (resolved) {
    return null;
  }

  return (
    <li className={styles.row}>
      <div className={styles.rowMain}>
        <span className={styles.name}>
          {request.MST_User ? `${request.MST_User.first_name} ${request.MST_User.last_name}` : "Unknown"}
        </span>
        <span className={styles.type}>{REQUEST_TYPE_LABELS[request.request_type]}</span>
      </div>
      <p className={styles.requestedTime}>
        Requested: {new Date(request.requested_timestamp).toLocaleString()}
      </p>
      <p className={styles.reason}>{request.reason}</p>

      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}

      {showRejectNote ? (
        <div className={styles.rejectForm}>
          <input
            className={styles.noteInput}
            placeholder="Rejection note (optional)"
            value={rejectionNote}
            onChange={(e) => setRejectionNote(e.target.value)}
          />
          <div className={styles.actions}>
            <Button variant="secondary" onClick={() => setShowRejectNote(false)} disabled={isSubmitting}>
              Back
            </Button>
            <Button variant="destructive" onClick={handleReject} disabled={isSubmitting}>
              Confirm reject
            </Button>
          </div>
        </div>
      ) : (
        <div className={styles.actions}>
          <Button variant="destructive" onClick={() => setShowRejectNote(true)} disabled={isSubmitting}>
            Reject
          </Button>
          <Button onClick={handleApprove} disabled={isSubmitting}>
            Approve
          </Button>
        </div>
      )}
    </li>
  );
}
