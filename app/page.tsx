import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "@/components/features/auth/SignOutButton";
import { ClockCard } from "@/components/features/timekeeping/ClockCard";
import { GpsConsentSheet } from "@/components/features/timekeeping/GpsConsentSheet";
import styles from "./page.module.css";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: profile } = user
    ? await supabase.from("MST_User").select("first_name, role").eq("id", user.id).single()
    : { data: null };

  return (
    <main className={styles.main}>
      <div className={styles.header}>
        <h1 className={styles.title}>{profile ? `Hi, ${profile.first_name}` : "zedHR"}</h1>
        <div className={styles.headerActions}>
          <Link href="/timesheet">Timesheet</Link>
          <Link href="/requests">Requests</Link>
          {(profile?.role === "manager" || profile?.role === "admin") && (
            <Link href="/dashboard">Dashboard</Link>
          )}
          {profile?.role === "admin" && <Link href="/admin">Admin</Link>}
          <SignOutButton />
        </div>
      </div>
      <ClockCard />
      <GpsConsentSheet />
    </main>
  );
}
