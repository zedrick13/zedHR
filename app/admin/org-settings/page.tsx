import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentOrgId } from "@/lib/org";
import { AppHeader } from "@/components/features/navigation/AppHeader";
import { AdminNav } from "@/components/features/admin/AdminNav";
import { OrgSettingsForm } from "./OrgSettingsForm";
import styles from "../page.module.css";

export default async function OrgSettingsPage() {
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

  const { data: org } = await supabase
    .from("MST_Organization")
    .select("*")
    .eq("id", organizationId)
    .single();

  if (!org) {
    return null;
  }

  return (
    <main className={styles.main}>
      <AppHeader title="Org Settings" />
      <AdminNav current="org-settings" />

      <section className={styles.section}>
        <OrgSettingsForm org={org} />
      </section>
    </main>
  );
}
