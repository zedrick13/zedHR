import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrgId } from "@/lib/org";
import { AppHeader } from "@/components/features/navigation/AppHeader";
import { AdminNav } from "@/components/features/admin/AdminNav";
import { WorkArrangementForm } from "./WorkArrangementForm";
import styles from "../page.module.css";

export default async function WorkArrangementsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase.from("MST_User").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") {
    redirect("/");
  }

  const organizationId = await getCurrentOrgId();

  const { data: departments } = await supabase.from("MST_Department").select("id, name").order("name");
  const { data: employees } = await supabase
    .from("MST_User")
    .select("id, first_name, last_name, department_id")
    .eq("is_active", true)
    .order("first_name");

  const { data: arrangements } = await supabase
    .from("TIM_WorkArrangement")
    .select("id, target_level, target_id, arrangement, effective_date, expires_date")
    .order("effective_date", { ascending: false });

  return (
    <main className={styles.main}>
      <AppHeader title="Work Arrangements" />
      <AdminNav current="work-arrangements" />

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Set an arrangement</h2>
        <WorkArrangementForm
          organizationId={organizationId}
          departments={departments ?? []}
          employees={employees ?? []}
          existing={arrangements ?? []}
        />
      </section>
    </main>
  );
}
