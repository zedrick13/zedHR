import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppHeader } from "@/components/features/navigation/AppHeader";
import { AdminNav } from "@/components/features/admin/AdminNav";
import { HolidayForm } from "./HolidayForm";
import { HolidayRow } from "./HolidayRow";
import styles from "../page.module.css";

export default async function HolidaysPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase.from("MST_User").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") {
    redirect("/");
  }

  const { data: holidays } = await supabase
    .from("MST_Holiday")
    .select("id, date, name, type, region_scope")
    .order("date");

  return (
    <main className={styles.main}>
      <AppHeader title="Holidays" />
      <AdminNav current="holidays" />

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>New holiday</h2>
        <HolidayForm />
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Holidays</h2>
        {!holidays || holidays.length === 0 ? (
          <p className={styles.empty}>No holidays yet.</p>
        ) : (
          <ul className={styles.list}>
            {holidays.map((holiday) => (
              <HolidayRow key={holiday.id} holiday={holiday} />
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
