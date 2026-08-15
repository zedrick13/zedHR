import styles from "./Skeleton.module.css";

// CLAUDE.md "Definition of done": loading (skeleton >300ms). A CSS
// animation-delay gates visibility so a load that finishes before 300ms
// never shows the skeleton at all — only a genuinely slow load does.
export function Skeleton({
  width,
  height,
  className,
}: {
  width?: string | number;
  height?: string | number;
  className?: string;
}) {
  return (
    <div
      className={[styles.skeleton, className].filter(Boolean).join(" ")}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}
