import { createClient } from "@/lib/supabase/server";
import { getCurrentOrgId } from "@/lib/org";
import { computeCurrentPayCycleRange } from "@/lib/payCycle";
import { AppHeader } from "@/components/features/navigation/AppHeader";
import { RequestCorrectionButton } from "@/components/features/corrections/RequestCorrectionButton";
import styles from "./page.module.css";

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${m}m`;
}

function formatTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function geoChip(geoStatus: string | null, outsideBoundary: boolean | null) {
  if (geoStatus !== "checked") {
    return { label: "No GPS", tone: "neutral" as const };
  }
  return outsideBoundary
    ? { label: "Out of bounds", tone: "warning" as const }
    : { label: "Ok", tone: "positive" as const };
}

export default async function TimesheetPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  let organizationId: string;
  try {
    organizationId = await getCurrentOrgId();
  } catch {
    return null;
  }

  const { data: org } = await supabase
    .from("MST_Organization")
    .select("pay_cycle_type, pay_cycle_start_date")
    .eq("id", organizationId)
    .single();

  const range = org
    ? computeCurrentPayCycleRange(org.pay_cycle_type as "weekly" | "biweekly" | "monthly", org.pay_cycle_start_date)
    : null;

  const query = supabase
    .from("TIM_WorkSession")
    .select("*, TIM_CompensableBreak(*), TIM_NonCompensableBreak(*)")
    .eq("user_id", user.id)
    .order("clock_in_time", { ascending: false });

  const { data: sessions } = range
    ? await query.gte("clock_in_time", range.start.toISOString()).lte("clock_in_time", range.end.toISOString())
    : await query;

  return (
    <main className={styles.main}>
      <AppHeader title="Timesheet" />
      {range && (
        <p className={styles.range}>
          {range.start.toLocaleDateString()} – {range.end.toLocaleDateString()}
        </p>
      )}
      <RequestCorrectionButton
        workSessionId={null}
        allowedTypes={["create_session"]}
        label="Report a missing shift"
      />

      {!sessions || sessions.length === 0 ? (
        <p className={styles.empty}>No shifts in this pay cycle yet.</p>
      ) : (
        <ul className={styles.list}>
          {sessions.map((session) => {
            const chip = geoChip(session.clock_in_geo_status, session.clock_in_outside_boundary);
            const duration = session.clock_out_time
              ? new Date(session.clock_out_time).getTime() - new Date(session.clock_in_time).getTime()
              : null;
            const violations = [
              ...session.TIM_CompensableBreak.filter((b) => b.policy_violation),
              ...session.TIM_NonCompensableBreak.filter((b) => b.policy_violation),
            ];

            return (
              <li key={session.id} className={styles.row}>
                <div className={styles.rowMain}>
                  <span className={styles.date}>{formatDate(session.clock_in_time)}</span>
                  <span className={styles.times}>
                    {formatTime(session.clock_in_time)} – {formatTime(session.clock_out_time)}
                  </span>
                  {duration !== null && (
                    <span className={styles.duration}>{formatDuration(duration)}</span>
                  )}
                </div>
                <div className={styles.chips}>
                  <span className={`${styles.chip} ${styles[`chip_${chip.tone}`]}`}>{chip.label}</span>
                  {violations.map((v) => (
                    <span key={v.id} className={`${styles.chip} ${styles.chip_warning}`}>
                      {v.policy_violation_reason}
                    </span>
                  ))}
                </div>
                <RequestCorrectionButton
                  workSessionId={session.id}
                  allowedTypes={["clock_in", "clock_out", "cb_start", "cb_end", "lb_start", "lb_end"]}
                />
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
