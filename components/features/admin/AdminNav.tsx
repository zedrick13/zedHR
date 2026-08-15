import Link from "next/link";
import styles from "./AdminNav.module.css";

export type AdminSection =
  | "invitations"
  | "dsar"
  | "departments"
  | "work-arrangements"
  | "holidays"
  | "org-settings"
  | "audit-log";

const SECTIONS: { key: AdminSection; href: string; label: string }[] = [
  { key: "invitations", href: "/admin", label: "Invitations" },
  { key: "dsar", href: "/admin/dsar", label: "DSAR" },
  { key: "departments", href: "/admin/departments", label: "Departments" },
  { key: "work-arrangements", href: "/admin/work-arrangements", label: "Work Arrangements" },
  { key: "holidays", href: "/admin/holidays", label: "Holidays" },
  { key: "org-settings", href: "/admin/org-settings", label: "Org Settings" },
  { key: "audit-log", href: "/admin/audit-log", label: "Audit Log" },
];

// Sub-nav within the admin section (SPEC's `/admin/*` route map).
export function AdminNav({ current }: { current: AdminSection }) {
  return (
    <nav className={styles.nav} aria-label="Admin sections">
      {SECTIONS.map((section) => (
        <Link
          key={section.key}
          href={section.href}
          className={current === section.key ? styles.active : undefined}
        >
          {section.label}
        </Link>
      ))}
    </nav>
  );
}
