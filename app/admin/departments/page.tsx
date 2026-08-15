import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppHeader } from "@/components/features/navigation/AppHeader";
import { AdminNav } from "@/components/features/admin/AdminNav";
import { DepartmentForm } from "./DepartmentForm";
import { DepartmentRow } from "./DepartmentRow";
import styles from "../page.module.css";

export default async function DepartmentsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase.from("MST_User").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") {
    redirect("/");
  }

  const { data: departments } = await supabase
    .from("MST_Department")
    .select("id, name, manager_id, MST_User!fk_department_manager(first_name, last_name)")
    .order("name");

  const { data: managers } = await supabase
    .from("MST_User")
    .select("id, first_name, last_name")
    .in("role", ["manager", "admin"])
    .eq("is_active", true)
    .order("first_name");

  return (
    <main className={styles.main}>
      <AppHeader title="Departments" />
      <AdminNav current="departments" />

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>New department</h2>
        <DepartmentForm managers={managers ?? []} />
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Departments</h2>
        {!departments || departments.length === 0 ? (
          <p className={styles.empty}>No departments yet.</p>
        ) : (
          <ul className={styles.list}>
            {departments.map((department) => (
              <DepartmentRow key={department.id} department={department} managers={managers ?? []} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
