import { Skeleton } from "./Skeleton";
import styles from "./PageSkeleton.module.css";

// Generic Next.js `loading.tsx` shell shown while a server component's data
// fetch is pending (App Router Suspense boundary). Deliberately generic
// rather than a pixel replica of the eventual page — it can't know the
// signed-in user/role yet (that's what's still loading), so it never tries
// to render a real AppHeader/AdminNav. `subNav` renders a thin placeholder
// row for routes that have one (the /admin/* family).
export function PageSkeleton({ rows = 4, subNav = false }: { rows?: number; subNav?: boolean }) {
  return (
    <main className={styles.main}>
      <div className={styles.header}>
        <Skeleton width="40%" height={34} />
        <Skeleton width={80} height={32} />
      </div>
      {subNav && (
        <div className={styles.subNav}>
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} width={90} height={20} />
          ))}
        </div>
      )}
      <div className={styles.rows}>
        {Array.from({ length: rows }).map((_, index) => (
          <Skeleton key={index} height={64} />
        ))}
      </div>
    </main>
  );
}
