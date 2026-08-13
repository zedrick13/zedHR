export default function Home() {
  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-2)",
        padding: "var(--inset-desktop)",
      }}
    >
      <h1 style={{ font: "var(--font-large-title)" }}>zedHR</h1>
      <p style={{ font: "var(--font-body)", color: "var(--label-secondary)" }}>
        Timekeeping module scaffold — M0.
      </p>
    </main>
  );
}
