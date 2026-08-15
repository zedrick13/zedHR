import type { ReactNode } from "react";
import styles from "./Sheet.module.css";

// SPEC §9: bottom sheet + grab handle on mobile, centered card on desktop.
export function Sheet({ children }: { children: ReactNode }) {
  return (
    <div className={styles.overlay}>
      <div className={styles.sheet} role="dialog" aria-modal="true">
        <div className={styles.grabHandle} />
        {children}
      </div>
    </div>
  );
}
