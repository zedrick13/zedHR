"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/callRpc";
import { buildTimesheetReportCsv, downloadCsv, type TimesheetReportRow } from "@/lib/csv";
import { Button } from "@/components/ui/Button";
import styles from "./DsarRequestRow.module.css";

type DsarRow = {
  id: string;
  user_id: string;
  request_type: string;
  status: string;
  notes: string | null;
  resolution_note: string | null;
  created_at: string;
  resolved_at: string | null;
  MST_User: { first_name: string; last_name: string } | null;
};

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  resolved: "Resolved",
  declined: "Declined",
};

export function DsarRequestRow({ request }: { request: DsarRow }) {
  const router = useRouter();
  const [showResolveForm, setShowResolveForm] = useState(false);
  const [resolutionNote, setResolutionNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);

  const employeeName = request.MST_User
    ? `${request.MST_User.first_name} ${request.MST_User.last_name}`
    : "Unknown";

  async function handleResolve() {
    setIsSubmitting(true);
    setError(null);
    const supabase = createClient();
    const { error: rpcError } = await callRpc(supabase, "resolve_dsar_request", {
      p_dsar_id: request.id,
      p_resolution_note: resolutionNote || null,
    });
    setIsSubmitting(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    router.refresh();
  }

  async function handleExport() {
    setIsExporting(true);
    setError(null);
    const supabase = createClient();
    const { data, error: rpcError } = await callRpc<TimesheetReportRow[]>(
      supabase,
      "export_timesheet_report",
      { p_employee_id: request.user_id },
    );
    setIsExporting(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    downloadCsv(buildTimesheetReportCsv(data ?? []), `dsar-${request.user_id}-timesheet.csv`);
  }

  return (
    <li className={styles.row}>
      <div className={styles.rowMain}>
        <span className={styles.name}>{employeeName}</span>
        <span className={styles.type}>{request.request_type}</span>
        <span className={`${styles.status} ${styles[`status_${request.status}`]}`}>
          {STATUS_LABELS[request.status] ?? request.status}
        </span>
      </div>
      <p className={styles.meta}>Logged {new Date(request.created_at).toLocaleString()}</p>
      {request.notes && <p className={styles.notes}>{request.notes}</p>}
      {request.resolved_at && (
        <p className={styles.meta}>
          {STATUS_LABELS[request.status]} {new Date(request.resolved_at).toLocaleString()}
          {request.resolution_note ? ` — ${request.resolution_note}` : ""}
        </p>
      )}

      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}

      <div className={styles.actions}>
        {request.request_type === "access" && (
          <Button variant="secondary" onClick={handleExport} disabled={isExporting}>
            {isExporting ? "Exporting…" : "Export CSV"}
          </Button>
        )}

        {request.status === "pending" &&
          (showResolveForm ? (
            <div className={styles.resolveForm}>
              <input
                className={styles.noteInput}
                placeholder="Resolution note (optional)"
                value={resolutionNote}
                onChange={(event) => setResolutionNote(event.target.value)}
              />
              <Button variant="secondary" onClick={() => setShowResolveForm(false)} disabled={isSubmitting}>
                Back
              </Button>
              <Button onClick={handleResolve} disabled={isSubmitting}>
                {isSubmitting ? "Resolving…" : "Confirm resolve"}
              </Button>
            </div>
          ) : (
            <Button onClick={() => setShowResolveForm(true)}>Resolve</Button>
          ))}
      </div>
    </li>
  );
}
