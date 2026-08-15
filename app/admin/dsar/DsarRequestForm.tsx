"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/callRpc";
import { Button } from "@/components/ui/Button";
import styles from "./DsarRequestForm.module.css";

type Employee = { id: string; first_name: string; last_name: string };

export function DsarRequestForm({ employees }: { employees: Employee[] }) {
  const router = useRouter();
  const [userId, setUserId] = useState(employees[0]?.id ?? "");
  const [type, setType] = useState<"access" | "erasure">("access");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(false);

    if (!userId) {
      setError("Choose an employee.");
      return;
    }

    setIsSubmitting(true);
    const supabase = createClient();
    const { error: rpcError } = await callRpc(supabase, "log_dsar_request", {
      p_user_id: userId,
      p_type: type,
      p_notes: notes || null,
    });
    setIsSubmitting(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    setSuccess(true);
    setNotes("");
    router.refresh();
  }

  if (employees.length === 0) {
    return <p className={styles.empty}>No active employees to log a request for.</p>;
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <label className={styles.field}>
        <span>Employee</span>
        <select className={styles.select} value={userId} onChange={(event) => setUserId(event.target.value)}>
          {employees.map((employee) => (
            <option key={employee.id} value={employee.id}>
              {employee.first_name} {employee.last_name}
            </option>
          ))}
        </select>
      </label>

      <label className={styles.field}>
        <span>Request type</span>
        <select
          className={styles.select}
          value={type}
          onChange={(event) => setType(event.target.value as "access" | "erasure")}
        >
          <option value="access">Access</option>
          <option value="erasure">Erasure</option>
        </select>
      </label>

      <label className={styles.field}>
        <span>Notes</span>
        <textarea
          className={styles.textarea}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          maxLength={1000}
          rows={3}
        />
      </label>

      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      {success && <p className={styles.success}>Request logged.</p>}

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Logging…" : "Log request"}
      </Button>
    </form>
  );
}
