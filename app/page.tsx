import { createClient } from "@/lib/supabase/server";
import { AppHeader } from "@/components/features/navigation/AppHeader";
import { ClockCard } from "@/components/features/timekeeping/ClockCard";
import { GpsConsentSheet } from "@/components/features/timekeeping/GpsConsentSheet";
import styles from "./page.module.css";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: profile } = user
    ? await supabase.from("MST_User").select("first_name").eq("id", user.id).single()
    : { data: null };

  return (
    <main className={styles.main}>
      <AppHeader title={profile ? `Hi, ${profile.first_name}` : "zedHR"} />
      <ClockCard />
      <GpsConsentSheet />
    </main>
  );
}
