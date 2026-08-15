import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppHeader } from "@/components/features/navigation/AppHeader";
import { AdminNav } from "@/components/features/admin/AdminNav";
import { DsarRequestForm } from "./DsarRequestForm";
import { DsarRequestRow } from "./DsarRequestRow";
import styles from "../page.module.css";

export default async function DsarPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const { data: profile } = await supabase.from("MST_User").select("role").eq("id", user.id).single();
  if (profile?.role !== "admin") {
    redirect("/");
  }

  const { data: employees } = await supabase
    .from("MST_User")
    .select("id, first_name, last_name")
    .eq("is_active", true)
    .order("first_name");

  const { data: requests } = await supabase
    .from("MST_DSARRequest")
    .select("*, MST_User!MST_DSARRequest_user_id_fkey(first_name, last_name)")
    .order("created_at", { ascending: false });

  const pending = (requests ?? []).filter((r) => r.status === "pending");
  const resolved = (requests ?? []).filter((r) => r.status !== "pending");

  return (
    <main className={styles.main}>
      <AppHeader title="DSAR" />
      <AdminNav current="dsar" />

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Log a new request</h2>
        <DsarRequestForm employees={employees ?? []} />
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Pending ({pending.length})</h2>
        {pending.length === 0 ? (
          <p className={styles.empty}>No pending requests.</p>
        ) : (
          <ul className={styles.list}>
            {pending.map((request) => (
              <DsarRequestRow key={request.id} request={request} />
            ))}
          </ul>
        )}
      </section>

      {resolved.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Resolved</h2>
          <ul className={styles.list}>
            {resolved.map((request) => (
              <DsarRequestRow key={request.id} request={request} />
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
