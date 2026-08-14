import { createClient } from "@/lib/supabase/server";
import { InviteForm } from "./InviteForm";
import { RevokeButton } from "./RevokeButton";
import styles from "./page.module.css";

export default async function AdminPage() {
  const supabase = await createClient();
  const { data: invitations } = await supabase
    .from("MST_UserInvitation")
    .select("id, email, role, expires_at, is_used, revoked_at")
    .order("created_at", { ascending: false });

  const pending = (invitations ?? []).filter((i) => !i.is_used && !i.revoked_at);

  return (
    <main className={styles.main}>
      <h1 className={styles.title}>Admin</h1>
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
