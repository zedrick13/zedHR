import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "@/components/features/auth/SignOutButton";
import { NotificationBell } from "@/components/features/notifications/NotificationBell";
import { OfflineSyncListener } from "@/components/features/timekeeping/OfflineSyncListener";
import styles from "./AppHeader.module.css";

// Shared authenticated-route header: page title + primary nav + the
// notification bell (SPEC §9 "Notification center" is a persistent element,
// not its own route, so it lives here rather than on one screen).
export async function AppHeader({ title }: { title: string }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <div className={styles.header}>
        <h1 className={styles.title}>{title}</h1>
      </div>
    );
  }

  const { data: profile } = await supabase
    .from("MST_User")
    .select("role")
    .eq("id", user.id)
    .single();

  const { data: notifications } = await supabase
    .from("NTF_Notification")
    .select("id, template, title, body, link_path, is_read, created_at")
    .order("created_at", { ascending: false })
    .limit(20);

  return (
    <div className={styles.header}>
      <h1 className={styles.title}>{title}</h1>
      <div className={styles.headerActions}>
        <Link href="/">Home</Link>
        <Link href="/timesheet">Timesheet</Link>
        <Link href="/requests">Requests</Link>
        {(profile?.role === "manager" || profile?.role === "admin") && (
          <Link href="/dashboard">Dashboard</Link>
        )}
        {profile?.role === "admin" && <Link href="/admin">Admin</Link>}
        <NotificationBell userId={user.id} initialNotifications={notifications ?? []} />
        <SignOutButton />
      </div>
      <OfflineSyncListener />
    </div>
  );
}
