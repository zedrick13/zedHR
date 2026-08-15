import type { ButtonHTMLAttributes } from "react";
import styles from "./Button.module.css";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "destructive";
};

export function Button({
  variant = "primary",
  className,
  ...props
}: ButtonProps) {
  const variantClass =
    variant === "primary"
      ? styles.primary
      : variant === "destructive"
        ? styles.destructive
        : styles.secondary;

  return (
    <button
      className={[styles.button, variantClass, className]
        .filter(Boolean)
        .join(" ")}
      {...props}
    />
  );
}
