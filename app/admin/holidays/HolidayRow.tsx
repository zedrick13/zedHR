"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/callRpc";
import { Button } from "@/components/ui/Button";
import styles from "../page.module.css";

type Holiday = { id: string; date: string; name: string; type: string; region_scope: string | null };

export function HolidayRow({ holiday }: { holiday: Holiday }) {
  const router = useRouter();
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setIsDeleting(true);
    setError(null);
    const supabase = createClient();
    const { error: rpcError } = await callRpc(supabase, "delete_holiday", { p_holiday_id: holiday.id });
    setIsDeleting(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    router.refresh();
  }

  return (
    <li className={styles.row}>
      <span>
        {holiday.date} — {holiday.name} ({holiday.type}
        {holiday.region_scope ? `, ${holiday.region_scope}` : ""})
      </span>
      <div>
        {error && <span role="alert">{error}</span>}
        <Button variant="destructive" onClick={handleDelete} disabled={isDeleting}>
          {isDeleting ? "Deleting…" : "Delete"}
        </Button>
      </div>
    </li>
  );
}
