import { checkPasswordRules } from "@/lib/passwordPolicy";
import styles from "./PasswordRules.module.css";

export function PasswordRules({ password }: { password: string }) {
  const rules = checkPasswordRules(password);

  return (
    <ul className={styles.rules}>
      {rules.map((rule) => (
        <li key={rule.label} className={rule.met ? styles.ruleMet : styles.rule}>
          {rule.label}
        </li>
      ))}
    </ul>
  );
}
