"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/callRpc";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import styles from "../dsar/DsarRequestForm.module.css";
import pageStyles from "../page.module.css";

type Department = { id: string; name: string };
type Employee = { id: string; first_name: string; last_name: string; department_id: string | null };
type Arrangement = {
  id: string;
  target_level: string;
  target_id: string;
  arrangement: string;
  effective_date: string;
  expires_date: string | null;
};

type TargetLevel = "organization" | "department" | "user" | "day";

function targetsForLevelOf(
  level: TargetLevel,
  organizationId: string,
  departments: Department[],
  employees: Employee[],
): { id: string; label: string }[] {
  if (level === "department") return departments.map((d) => ({ id: d.id, label: d.name }));
  if (level === "user" || level === "day") {
    return employees.map((e) => ({ id: e.id, label: `${e.first_name} ${e.last_name}` }));
  }
  return [{ id: organizationId, label: "Whole organization" }];
}

export function WorkArrangementForm({
  organizationId,
  departments,
  employees,
  existing,
}: {
  organizationId: string;
  departments: Department[];
  employees: Employee[];
  existing: Arrangement[];
}) {
  const router = useRouter();
  const [targetLevel, setTargetLevel] = useState<TargetLevel>("user");
  const [targetId, setTargetId] = useState(employees[0]?.id ?? "");
  const [arrangement, setArrangement] = useState("office");
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().slice(0, 10));
  const [expiresDate, setExpiresDate] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const department of departments) map.set(department.id, department.name);
    for (const employee of employees) map.set(employee.id, `${employee.first_name} ${employee.last_name}`);
    map.set(organizationId, "Whole organization");
    return map;
  }, [departments, employees, organizationId]);

  const targetsForLevel = targetsForLevelOf(targetLevel, organizationId, departments, employees);

  function handleLevelChange(newLevel: TargetLevel) {
    setTargetLevel(newLevel);
    const nextTargets = targetsForLevelOf(newLevel, organizationId, departments, employees);
    setTargetId(nextTargets[0]?.id ?? "");
  }

  useEffect(() => {
    // Cascade preview: a genuine external-system side effect (an RPC call)
    // — only meaningful when targeting an actual employee (user/day level),
    // a department/org-level change doesn't resolve to a single answer
    // without picking a specific person. The early-return branches reset
    // the preview synchronously, same shape as GpsConsentSheet's/
    // useElapsedTime's "nothing to sync yet" resets.
    if ((targetLevel !== "user" && targetLevel !== "day") || !targetId || !effectiveDate) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPreview(null);
      return;
    }
    const employee = employees.find((e) => e.id === targetId);
    if (!employee) {
      setPreview(null);
      return;
    }

    let cancelled = false;
    async function loadPreview() {
      const supabase = createClient();
      const { data } = await callRpc<string>(supabase, "preview_work_arrangement", {
        p_user_id: targetId,
        p_department_id: employee!.department_id,
        p_date: effectiveDate,
      });
      if (!cancelled) {
        setPreview(data);
      }
    }
    void loadPreview();
    return () => {
      cancelled = true;
    };
  }, [targetLevel, targetId, effectiveDate, employees]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(false);
    setIsSubmitting(true);

    const supabase = createClient();
    const { error: rpcError } = await callRpc(supabase, "set_work_arrangement", {
      p_target_level: targetLevel,
      p_target_id: targetId,
      p_arrangement: arrangement,
      p_effective_date: effectiveDate,
      p_expires_date: expiresDate || null,
    });
    setIsSubmitting(false);

    if (rpcError) {
      setError(rpcError.message);
      return;
    }

    setSuccess(true);
    router.refresh();
  }

  return (
    <>
      <form className={styles.form} onSubmit={handleSubmit}>
        <label className={styles.field}>
          <span>Level</span>
          <select
            className={styles.select}
            value={targetLevel}
            onChange={(event) => handleLevelChange(event.target.value as TargetLevel)}
          >
            <option value="organization">Organization</option>
            <option value="department">Department</option>
            <option value="user">User (standing)</option>
            <option value="day">User (single day override)</option>
          </select>
        </label>

        {targetLevel !== "organization" && (
          <label className={styles.field}>
            <span>{targetLevel === "department" ? "Department" : "Employee"}</span>
            <select className={styles.select} value={targetId} onChange={(event) => setTargetId(event.target.value)}>
              {targetsForLevel.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.label}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className={styles.field}>
          <span>Arrangement</span>
          <select className={styles.select} value={arrangement} onChange={(event) => setArrangement(event.target.value)}>
            <option value="office">Office</option>
            <option value="wfh">WFH</option>
            <option value="hybrid">Hybrid</option>
          </select>
        </label>

        <TextField
          label="Effective date"
          type="date"
          required
          value={effectiveDate}
          onChange={(event) => setEffectiveDate(event.target.value)}
        />
        <TextField
          label="Expires date (optional)"
          type="date"
          value={expiresDate}
          onChange={(event) => setExpiresDate(event.target.value)}
        />

        {preview && (
          <p className={styles.success}>
            On {effectiveDate}, this employee currently resolves to <strong>{preview}</strong>
            {preview !== arrangement ? ` — will become "${arrangement}" after this change.` : " already."}
          </p>
        )}

        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}
        {success && <p className={styles.success}>Arrangement saved.</p>}

        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Set arrangement"}
        </Button>
      </form>

      <div className={pageStyles.section}>
        <h2 className={pageStyles.sectionTitle}>Existing arrangements</h2>
        {existing.length === 0 ? (
          <p className={pageStyles.empty}>No arrangements set yet.</p>
        ) : (
          <ul className={pageStyles.list}>
            {existing.map((row) => (
              <li key={row.id} className={pageStyles.row}>
                <span>
                  {row.target_level} — {nameById.get(row.target_id) ?? row.target_id} — {row.arrangement} (
                  {row.effective_date}
                  {row.expires_date ? ` to ${row.expires_date}` : ""})
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
