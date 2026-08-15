"use client";

import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { runSyncWorker } from "@/lib/offline/syncWorker";
import { getQueue } from "@/lib/offline/queue";

/**
 * No UI — just the `online` listener SPEC.md §8.1 asks for, mounted once
 * per authenticated session via AppHeader (same "always present" pattern
 * as NotificationBell). Also runs once on mount in case the app was
 * reloaded while already back online with a leftover queue.
 */
export function OfflineSyncListener() {
  useEffect(() => {
    const supabase = createClient();

    function sync() {
      void runSyncWorker(supabase);
    }

    if (typeof navigator !== "undefined" && navigator.onLine && getQueue().length > 0) {
      sync();
    }

    window.addEventListener("online", sync);
    return () => window.removeEventListener("online", sync);
  }, []);

  return null;
}
