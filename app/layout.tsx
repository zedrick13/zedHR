import type { Metadata } from "next";
import "../styles/tokens.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "zedHR",
  description: "zedHR Timekeeping",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
