"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/callRpc";
import styles from "./DirectReportsGrid.module.css";

type Row = {
  user_id: string;
  first_name: string;
  last_name: string;
  department_id: string | null;
  department_name: string | null;
  status: string;
  today_seconds: number;
  geofence_state: string | null;
};

const STATUS_LABELS: Record<string, string> = {
  clocked_in: "Clocked In",
  on_cb: "On Break",
  on_lb: "On Lunch",
  clocked_out: "Clocked Out",
};

const GEOFENCE_LABELS: Record<string, string> = {
  ok: "Ok",
  out_of_bounds: "Out of Bounds",
  wfh: "N/A (WFH)",
  no_gps: "N/A (No GPS)",
};

function formatHours(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export function DirectReportsGrid({
  initialRows,
  role,
}: {
  initialRows: Row[];
  role: "manager" | "admin";
}) {
  const [rows, setRows] = useState(initialRows);

  useEffect(() => {
    // Refetches the whole grid on any relevant change rather than patching
    // individual rows — at ~50 employees this is cheap, and it keeps status/
    // hours/geofence (all derived server-side from several tables) always
    // internally consistent instead of hand-merging partial CDC payloads.
    const supabase = createClient();

    async function refetch() {
      const { data } = await callRpc<Row[]>(supabase, "get_direct_reports_status");
      if (data) setRows(data);
    }

    const channel = supabase
      .channel("dashboard-direct-reports")
      .on("postgres_changes", { event: "*", schema: "public", table: "TIM_WorkSession" }, refetch)
      .on("postgres_changes", { event: "*", schema: "public", table: "TIM_CompensableBreak" }, refetch)
      .on("postgres_changes", { event: "*", schema: "public", table: "TIM_NonCompensableBreak" }, refetch)
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const total = rows.length;
  const clockedIn = rows.filter((row) => row.status !== "clocked_out").length;
  const onBreak = rows.filter((row) => row.status === "on_cb" || row.status === "on_lb").length;
  const distinctDepartments = new Set(rows.map((row) => row.department_id)).size;
  const showDepartmentColumn = role === "admin" || distinctDepartments > 1;

  return (
    <div className={styles.wrapper}>
      <div className={styles.headcount}>
        <div className={styles.stat}>
          <span className={styles.statValue}>{total}</span>
          <span className={styles.statLabel}>Direct reports</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{clockedIn}</span>
          <span className={styles.statLabel}>Clocked in</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statValue}>{onBreak}</span>
          <span className={styles.statLabel}>On break</span>
        </div>
      </div>

      {rows.length === 0 ? (
        <p className={styles.empty}>No direct reports yet.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Name</th>
                {showDepartmentColumn && <th>Department</th>}
                <th>Status</th>
                <th>Today&rsquo;s Hours</th>
                <th>Geofence</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.user_id}>
                  <td>
                    {row.first_name} {row.last_name}
                  </td>
                  {showDepartmentColumn && <td>{row.department_name ?? "—"}</td>}
                  <td>{STATUS_LABELS[row.status] ?? row.status}</td>
                  <td className={styles.hours}>{formatHours(row.today_seconds)}</td>
                  <td>
                    <span
                      className={`${styles.chip} ${styles[`chip_${row.geofence_state ?? "none"}`] ?? ""}`}
                    >
                      {row.geofence_state ? GEOFENCE_LABELS[row.geofence_state] : "—"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
