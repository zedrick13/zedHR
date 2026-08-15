import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppHeader } from "@/components/features/navigation/AppHeader";
import { AdminNav } from "@/components/features/admin/AdminNav";
import { AuditLogFilter } from "./AuditLogFilter";
import styles from "../page.module.css";
import rowStyles from "./AuditLogRow.module.css";

const ACTION_TYPES = [
  "CLOCK_IN",
  "CLOCK_OUT",
  "CB_STARTED",
  "CB_ENDED",
  "LB_STARTED",
  "LB_ENDED",
  "CORRECTION_SUBMITTED",
  "CORRECTION_APPROVED",
  "CORRECTION_REJECTED",
  "TIMECARD_ADMIN_EDITED",
  "INVITATION_CREATED",
  "INVITATION_REVOKED",
  "INVITATION_ACCEPTED",
  "USER_TERMINATED",
  "USER_ANONYMIZED",
  "MFA_ENROLLED",
  "MFA_RESET",
  "USER_ROLE_CHANGED",
  "DSAR_REQUEST_LOGGED",
  "DSAR_REQUEST_FULFILLED",
  "LOGIN_FAILED",
  "LOGIN_LOCKOUT",
  "RATE_LIMIT_TRIGGERED",
  "SYNC_CONFLICT_LOGGED",
  "SUSPICIOUS_DRIFT_DETECTED",
  "DEPARTMENT_CREATED",
  "DEPARTMENT_UPDATED",
  "WORK_ARRANGEMENT_SET",
  "HOLIDAY_CREATED",
  "HOLIDAY_DELETED",
  "ORG_SETTINGS_UPDATED",
];

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{ action_type?: string }>;
}) {
  const { action_type: actionTypeFilter } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase.from("MST_User").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") {
    redirect("/");
  }

  let query = supabase
    .from("AUD_SystemLog")
    .select("id, action_type, target_id, created_at, MST_User!AUD_SystemLog_actor_id_fkey(first_name, last_name)")
    .order("created_at", { ascending: false })
    .limit(100);

  if (actionTypeFilter) {
    query = query.eq("action_type", actionTypeFilter);
  }

  const { data: rows } = await query;

  return (
    <main className={styles.main}>
      <AppHeader title="Audit Log" />
      <AdminNav current="audit-log" />

      <section className={styles.section}>
        <AuditLogFilter actionTypes={ACTION_TYPES} current={actionTypeFilter ?? ""} />

        {!rows || rows.length === 0 ? (
          <p className={styles.empty}>No matching events.</p>
        ) : (
          <div className={rowStyles.tableWrap}>
            <table className={rowStyles.table}>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Actor</th>
                  <th>Target</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{new Date(row.created_at).toLocaleString()}</td>
                    <td>{row.action_type}</td>
                    <td>{row.MST_User ? `${row.MST_User.first_name} ${row.MST_User.last_name}` : "System"}</td>
                    <td className={rowStyles.targetId}>{row.target_id ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
