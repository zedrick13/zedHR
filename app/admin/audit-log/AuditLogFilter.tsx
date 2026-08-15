"use client";

import { useRouter } from "next/navigation";
import styles from "../dsar/DsarRequestForm.module.css";

export function AuditLogFilter({ actionTypes, current }: { actionTypes: string[]; current: string }) {
  const router = useRouter();

  return (
    <label className={styles.field}>
      <span>Filter by action type</span>
      <select
        className={styles.select}
        value={current}
        onChange={(event) => {
          const value = event.target.value;
          router.push(value ? `/admin/audit-log?action_type=${value}` : "/admin/audit-log");
        }}
      >
        <option value="">All</option>
        {actionTypes.map((actionType) => (
          <option key={actionType} value={actionType}>
            {actionType}
          </option>
        ))}
      </select>
    </label>
  );
}
