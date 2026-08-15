"use client";

import { useEffect, useState } from "react";

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

/** Live HH:MM:SS elapsed since startTime, ticking every second. */
export function useElapsedTime(startTime: string | null): string {
  const [elapsed, setElapsed] = useState("00:00:00");

  useEffect(() => {
    // Syncing with an external clock (wall time) — the textbook case for an
    // effect, per React's own guidance on periodic re-measurement.
    if (!startTime) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setElapsed("00:00:00");
      return;
    }

    const start = new Date(startTime).getTime();

    function tick() {
      const totalSeconds = Math.max(0, Math.floor((Date.now() - start) / 1000));
      const h = Math.floor(totalSeconds / 3600);
      const m = Math.floor((totalSeconds % 3600) / 60);
      const s = totalSeconds % 60;
      setElapsed(`${pad(h)}:${pad(m)}:${pad(s)}`);
    }

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  return elapsed;
}
