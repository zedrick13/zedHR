import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrgId } from "@/lib/org";
import { AppHeader } from "@/components/features/navigation/AppHeader";
import { DirectReportsGrid } from "@/components/features/dashboard/DirectReportsGrid";
import { ReportsPane } from "@/components/features/dashboard/ReportsPane";
import type { PayCycleType } from "@/lib/payCycle";
import { CorrectionReviewRow } from "./CorrectionReviewRow";
import { AdminTimecardEditForm } from "./AdminTimecardEditForm";
import styles from "./page.module.css";

// SPEC's route map puts the corrections queue on /dashboard alongside a
// headcount widget, direct reports grid, and reports pane. M4 shipped just
// the corrections queue; M5 adds the rest here.
export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const { data: profile } = await supabase.from("MST_User").select("role").eq("id", user.id).single();

  if (profile?.role !== "manager" && profile?.role !== "admin") {
    redirect("/");
  }

  const organizationId = await getCurrentOrgId();

  const { data: directReports } = await supabase.rpc("get_direct_reports_status");

  const { data: org } = await supabase
    .from("MST_Organization")
    .select("pay_cycle_type, pay_cycle_start_date")
    .eq("id", organizationId)
    .single();

  const departments = Array.from(
    new Map(
      (directReports ?? [])
        .filter((row) => row.department_id !== null)
        .map((row) => [row.department_id as string, { id: row.department_id as string, name: row.department_name ?? "—" }]),
    ).values(),
  );
  const people = (directReports ?? []).map((row) => ({
    id: row.user_id,
    name: `${row.first_name} ${row.last_name}`,
    departmentId: row.department_id,
  }));

  const { data: pending } = await supabase
    .from("TIM_CorrectionRequest")
    .select("*, MST_User!TIM_CorrectionRequest_user_id_fkey(first_name, last_name)")
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  return (
    <main className={styles.main}>
      <AppHeader title="Dashboard" />

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Direct reports</h2>
        <DirectReportsGrid initialRows={directReports ?? []} role={profile.role} />
      </section>

      {org && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Reports</h2>
          <ReportsPane
            people={people}
            departments={departments}
            payCycleType={org.pay_cycle_type as PayCycleType}
            payCycleStartDate={org.pay_cycle_start_date}
          />
        </section>
      )}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Corrections queue</h2>
        {!pending || pending.length === 0 ? (
          <p className={styles.empty}>No pending correction requests.</p>
        ) : (
          <ul className={styles.list}>
            {pending.map((request) => (
              <CorrectionReviewRow key={request.id} request={request} />
            ))}
          </ul>
        )}
      </section>

      {profile?.role === "admin" && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Edit a locked timecard</h2>
          <AdminTimecardEditForm />
        </section>
      )}
    </main>
  );
}
