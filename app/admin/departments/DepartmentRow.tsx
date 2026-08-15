"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/callRpc";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import styles from "../page.module.css";
import formStyles from "../dsar/DsarRequestForm.module.css";

type Manager = { id: string; first_name: string; last_name: string };
type Department = {
  id: string;
  name: string;
  manager_id: string | null;
  MST_User: { first_name: string; last_name: string } | null;
};

export function DepartmentRow({ department, managers }: { department: Department; managers: Manager[] }) {
  const router = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(department.name);
  const [managerId, setManagerId] = useState(department.manager_id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSave() {
    setIsSubmitting(true);
    setError(null);
    const supabase = createClient();
    const { error: rpcError } = await callRpc(supabase, "update_department", {
      p_department_id: department.id,
      p_name: name,
      p_manager_id: managerId || null,
    });
    setIsSubmitting(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }
    setIsEditing(false);
    router.refresh();
  }

  if (isEditing) {
    return (
      <li className={styles.row}>
        <div className={formStyles.form}>
          <TextField label="Name" value={name} onChange={(event) => setName(event.target.value)} />
          <label className={formStyles.field}>
            <span>Manager</span>
            <select
              className={formStyles.select}
              value={managerId}
              onChange={(event) => setManagerId(event.target.value)}
            >
              <option value="">Unmanaged</option>
              {managers.map((manager) => (
                <option key={manager.id} value={manager.id}>
                  {manager.first_name} {manager.last_name}
                </option>
              ))}
            </select>
          </label>
          {error && (
            <p role="alert" className={formStyles.error}>
              {error}
            </p>
          )}
          <div>
            <Button variant="secondary" onClick={() => setIsEditing(false)} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className={styles.row}>
      <span>
        {department.name} —{" "}
        {department.MST_User ? `${department.MST_User.first_name} ${department.MST_User.last_name}` : "Unmanaged"}
      </span>
      <Button variant="secondary" onClick={() => setIsEditing(true)}>
        Edit
      </Button>
    </li>
  );
}
