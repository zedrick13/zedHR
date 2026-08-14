import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppHeader } from "@/components/features/navigation/AppHeader";
import { DirectReportsGrid } from "@/components/features/dashboard/DirectReportsGrid";
import { CorrectionReviewRow } from "./CorrectionReviewRow";
import { AdminTimecardEditForm } from "./AdminTimecardEditForm";
import styles from "./page.module.css";

// SPEC's route map puts the corrections queue on /dashboard alongside a
// headcount widget, direct reports grid, and reports pane. M4 shipped just
// the corrections queue; M5 adds the headcount widget + Direct Reports
// grid here. The reports pane (dept/employee filters, CSV export) is still
// its own M5 checklist item, not yet built.
export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const { data: profile } = await supabase
    .from("MST_User")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "manager" && profile?.role !== "admin") {
    redirect("/");
  }

  const { data: directReports } = await supabase.rpc("get_direct_reports_status");

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
