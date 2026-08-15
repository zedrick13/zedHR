import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppHeader } from "@/components/features/navigation/AppHeader";
import { AdminNav } from "@/components/features/admin/AdminNav";
import { InviteForm } from "./InviteForm";
import { RevokeButton } from "./RevokeButton";
import styles from "./page.module.css";

export default async function AdminPage() {
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

  const { data: invitations } = await supabase
    .from("MST_UserInvitation")
    .select("id, email, role, expires_at, is_used, revoked_at")
    .order("created_at", { ascending: false });

  const pending = (invitations ?? []).filter((i) => !i.is_used && !i.revoked_at);

  return (
    <main className={styles.main}>
      <AppHeader title="Admin" />
      <AdminNav current="invitations" />
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Invite someone</h2>
        <InviteForm />
      </section>
      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Pending invitations</h2>
        {pending.length === 0 ? (
          <p className={styles.empty}>No pending invitations.</p>
        ) : (
          <InvitationList invitations={pending} />
        )}
      </section>
    </main>
  );
}

function InvitationList({
  invitations,
}: {
  invitations: { id: string; email: string; role: string; expires_at: string }[];
}) {
  return (
    <ul className={styles.list}>
      {invitations.map((invitation) => (
        <li key={invitation.id} className={styles.row}>
          <span>
            {invitation.email} — {invitation.role}
          </span>
          <RevokeButton invitationId={invitation.id} />
        </li>
      ))}
    </ul>
  );
}
