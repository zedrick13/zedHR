import { Button } from "@/components/ui/Button";
import styles from "./page.module.css";

export default function Home() {
  return (
    <main className={styles.main}>
      <h1 className={styles.title}>zedHR</h1>
      <p className={styles.subtitle}>Timekeeping module — scaffold shell.</p>
      <Button>Clock In</Button>
    </main>
  );
}
