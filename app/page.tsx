import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "@/components/features/auth/SignOutButton";
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
      <h1 className={styles.title}>
        {profile ? `Hi, ${profile.first_name}` : "zedHR"}
      </h1>
      <p className={styles.subtitle}>
        Timekeeping module — the clock in/out home screen lands in M3.
      </p>
      {profile?.role === "admin" && <Link href="/admin">Admin</Link>}
      <SignOutButton />
    </main>
  );
}
