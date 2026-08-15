import { createClient } from "@/lib/supabase/server";
import { AppHeader } from "@/components/features/navigation/AppHeader";
import { AvatarUpload } from "@/components/features/profile/AvatarUpload";
import styles from "./page.module.css";

// SPEC §9 route map: "/profile — Own info, avatar upload (Edge Function
// flow), password change." This is the avatar-upload slice (M7's own
// checklist item); password change isn't built yet — flagged in SPEC.md
// as a remaining gap rather than scope-creeping into it here.
export default async function ProfilePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const { data: profile } = await supabase
    .from("MST_User")
    .select("first_name, last_name, role, avatar_path")
    .eq("id", user.id)
    .single();

  const avatarUrl = profile?.avatar_path
    ? supabase.storage.from("avatars").getPublicUrl(profile.avatar_path).data.publicUrl
    : null;

  return (
    <main className={styles.main}>
      <AppHeader title="Profile" />

      <section className={styles.section}>
        <AvatarUpload initialAvatarUrl={avatarUrl} />
        <div className={styles.info}>
          <p className={styles.name}>
            {profile?.first_name} {profile?.last_name}
          </p>
          <p className={styles.role}>{profile?.role}</p>
          <p className={styles.email}>{user.email}</p>
        </div>
      </section>
    </main>
  );
}
