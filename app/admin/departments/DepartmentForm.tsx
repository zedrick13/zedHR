"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/callRpc";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import styles from "../dsar/DsarRequestForm.module.css";

type Manager = { id: string; first_name: string; last_name: string };

export function DepartmentForm({ managers }: { managers: Manager[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [managerId, setManagerId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const supabase = createClient();
    const { error: rpcError } = await callRpc(supabase, "create_department", {
      p_name: name,
      p_manager_id: managerId || null,
    });
    setIsSubmitting(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    setName("");
    setManagerId("");
    router.refresh();
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <TextField label="Name" required value={name} onChange={(event) => setName(event.target.value)} />

      <label className={styles.field}>
        <span>Manager</span>
        <select className={styles.select} value={managerId} onChange={(event) => setManagerId(event.target.value)}>
          <option value="">Unmanaged</option>
          {managers.map((manager) => (
            <option key={manager.id} value={manager.id}>
              {manager.first_name} {manager.last_name}
            </option>
          ))}
        </select>
      </label>

      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Creating…" : "Create department"}
      </Button>
    </form>
  );
}
