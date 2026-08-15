"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/callRpc";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import styles from "../dsar/DsarRequestForm.module.css";

export function HolidayForm() {
  const router = useRouter();
  const [date, setDate] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState("regular");
  const [regionScope, setRegionScope] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    const supabase = createClient();
    const { error: rpcError } = await callRpc(supabase, "create_holiday", {
      p_date: date,
      p_name: name,
      p_type: type,
      p_region_scope: regionScope || null,
    });
    setIsSubmitting(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    setDate("");
    setName("");
    setRegionScope("");
    router.refresh();
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <TextField label="Date" type="date" required value={date} onChange={(event) => setDate(event.target.value)} />
      <TextField label="Name" required value={name} onChange={(event) => setName(event.target.value)} />

      <label className={styles.field}>
        <span>Type</span>
        <select className={styles.select} value={type} onChange={(event) => setType(event.target.value)}>
          <option value="regular">Regular</option>
          <option value="special_non_working">Special non-working</option>
          <option value="custom">Custom</option>
        </select>
      </label>

      <TextField
        label="Region scope (optional)"
        value={regionScope}
        onChange={(event) => setRegionScope(event.target.value)}
      />

      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}

      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? "Creating…" : "Create holiday"}
      </Button>
    </form>
  );
}
