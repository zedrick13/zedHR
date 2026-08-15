import Link from "next/link";
import styles from "./AdminNav.module.css";

// Sub-nav within the admin section (SPEC's `/admin/*` route map covers
// invitations, DSAR, and — M7's own separate checklist item — departments/
// work arrangements/holidays/org settings/audit log, so this needs to
// scale past two links soon).
export function AdminNav({ current }: { current: "invitations" | "dsar" }) {
  return (
    <nav className={styles.nav} aria-label="Admin sections">
      <Link href="/admin" className={current === "invitations" ? styles.active : undefined}>
        Invitations
      </Link>
      <Link href="/admin/dsar" className={current === "dsar" ? styles.active : undefined}>
        DSAR
      </Link>
    </nav>
  );
}
