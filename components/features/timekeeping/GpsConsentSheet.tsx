"use client";

import { useEffect, useState } from "react";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import styles from "./GpsConsentSheet.module.css";

const STORAGE_KEY = "zedhr_gps_consent_acknowledged";

// SPEC §5.2 "GPS consent sheet on first run" (PH Data Privacy Act
// compliance): explains why we ask for location before the OS permission
// prompt appears. Shown once per browser; geolocation is never blocked
// or required by not acknowledging — this is informational only.
export function GpsConsentSheet() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Reads an external system (localStorage) on mount — there's no way to
    // know this without an effect (no SSR access to localStorage).
    if (!localStorage.getItem(STORAGE_KEY)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVisible(true);
    }
  }, []);

  function acknowledge() {
    localStorage.setItem(STORAGE_KEY, "1");
    setVisible(false);
  }

  if (!visible) {
    return null;
  }

  return (
    <Sheet>
      <h2 className={styles.title}>Location for clock-ins</h2>
      <p className={styles.body}>
        When you clock in or out, zedHR asks your browser for your location to confirm you&rsquo;re
        on-site. This is only used for that punch&rsquo;s audit record — you can still clock in and
        out if you decline, and it never blocks your punch.
      </p>
      <Button onClick={acknowledge}>Got it</Button>
    </Sheet>
  );
}
