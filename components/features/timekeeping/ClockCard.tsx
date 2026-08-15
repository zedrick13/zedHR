"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/callRpc";
import { getGeolocation } from "@/lib/geolocation";
import { enqueuePunch, getQueue, PUNCH_QUEUE_CHANGED_EVENT, type PunchAction } from "@/lib/offline/queue";
import { isApplicationErrorCode } from "@/lib/offline/networkError";
import { SYNC_COMPLETED_EVENT } from "@/lib/offline/syncWorker";
import { Button } from "@/components/ui/Button";
import { useElapsedTime } from "./useElapsedTime";
import styles from "./ClockCard.module.css";

type SessionState = "CLOCKED_OUT" | "CLOCKED_IN_IDLE" | "ON_CB" | "ON_LB";

type ActiveSessionState = {
  state: SessionState;
  session: {
    id: string;
    clock_in_time: string;
    clock_in_outside_boundary: boolean;
    clock_in_geo_status: string;
  } | null;
  active_break: { type: "cb" | "lb"; id: string; start_time: string } | null;
};

const PUNCH_ACTION_FOR_RPC: Record<"clock_in_user" | "clock_out_user", PunchAction> = {
  clock_in_user: "clock_in",
  clock_out_user: "clock_out",
};

// Best-effort local prediction of the next state while a punch is queued
// offline — the server's own state (fetched via refresh() once the sync
// worker replays the queue) is always the actual source of truth.
function optimisticNextState(current: ActiveSessionState, action: PunchAction): ActiveSessionState {
  const now = new Date().toISOString();
  switch (action) {
    case "clock_in":
      return {
        state: "CLOCKED_IN_IDLE",
        session: { id: "offline-pending", clock_in_time: now, clock_in_outside_boundary: false, clock_in_geo_status: "unavailable" },
        active_break: null,
      };
    case "clock_out":
      return { state: "CLOCKED_OUT", session: null, active_break: null };
    case "start_cb":
      return { ...current, state: "ON_CB", active_break: { type: "cb", id: "offline-pending", start_time: now } };
    case "start_lb":
      return { ...current, state: "ON_LB", active_break: { type: "lb", id: "offline-pending", start_time: now } };
    case "end_cb":
    case "end_lb":
      return { ...current, state: "CLOCKED_IN_IDLE", active_break: null };
  }
}

export function ClockCard() {
  const supabase = useMemo(() => createClient(), []);
  const [state, setState] = useState<ActiveSessionState | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDeniedBanner, setShowDeniedBanner] = useState(false);
  const [deniedShownThisSession, setDeniedShownThisSession] = useState(false);
  const [queuedCount, setQueuedCount] = useState(0);

  const refresh = useCallback(async () => {
    const { data } = await callRpc<ActiveSessionState>(supabase, "get_active_session_state");
    if (data) {
      setState(data);
    }
  }, [supabase]);

  useEffect(() => {
    // Syncing with an external system (server session state) on mount —
    // the setState the linter flags happens inside refresh() after an
    // await, not synchronously in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  useEffect(() => {
    // Reads the offline queue (localStorage) on mount — same "external
    // system, no SSR access" shape as GpsConsentSheet's effect.
    function updateQueuedCount() {
      setQueuedCount(getQueue().length);
    }
    updateQueuedCount();

    function onSyncCompleted() {
      updateQueuedCount();
      void refresh();
    }

    window.addEventListener(PUNCH_QUEUE_CHANGED_EVENT, updateQueuedCount);
    window.addEventListener(SYNC_COMPLETED_EVENT, onSyncCompleted);
    return () => {
      window.removeEventListener(PUNCH_QUEUE_CHANGED_EVENT, updateQueuedCount);
      window.removeEventListener(SYNC_COMPLETED_EVENT, onSyncCompleted);
    };
  }, [refresh]);

  const shiftElapsed = useElapsedTime(state?.session?.clock_in_time ?? null);
  const breakElapsed = useElapsedTime(state?.active_break?.start_time ?? null);

  function enqueueOffline(action: PunchAction, lat: number | null, lng: number | null) {
    enqueuePunch(action, lat, lng);
    setState((current) => (current ? optimisticNextState(current, action) : current));
  }

  async function punchWithGeo(rpcName: "clock_in_user" | "clock_out_user") {
    setIsPending(true);
    setError(null);

    const geo = await getGeolocation();
    if (geo.status === "denied" && !deniedShownThisSession) {
      setShowDeniedBanner(true);
      setDeniedShownThisSession(true);
    }

    const lat = geo.status === "checked" ? geo.lat : null;
    const lng = geo.status === "checked" ? geo.lng : null;
    const action = PUNCH_ACTION_FOR_RPC[rpcName];

    if (typeof navigator !== "undefined" && !navigator.onLine) {
      enqueueOffline(action, lat, lng);
      setIsPending(false);
      return;
    }

    const { error: rpcError } = await callRpc(supabase, rpcName, {
      p_lat: lat,
      p_lng: lng,
      p_geo_status: geo.status,
    });

    if (rpcError) {
      if (!isApplicationErrorCode(rpcError.code)) {
        enqueueOffline(action, lat, lng);
        setIsPending(false);
        return;
      }
      setError(rpcError.message);
    }
    await refresh();
    setIsPending(false);
  }

  async function punchSimple(rpcName: "start_cb" | "end_cb" | "start_lb" | "end_lb") {
    setIsPending(true);
    setError(null);

    if (typeof navigator !== "undefined" && !navigator.onLine) {
      enqueueOffline(rpcName, null, null);
      setIsPending(false);
      return;
    }

    const { error: rpcError } = await callRpc(supabase, rpcName);

    if (rpcError) {
      if (!isApplicationErrorCode(rpcError.code)) {
        enqueueOffline(rpcName, null, null);
        setIsPending(false);
        return;
      }
      setError(rpcError.message);
    }
    await refresh();
    setIsPending(false);
  }

  if (!state) {
    return <div className={styles.card} aria-busy="true" />;
  }

  return (
    <div className={styles.card}>
      {queuedCount > 0 && (
        <p className={styles.banner} role="status">
          {queuedCount === 1
            ? "1 punch queued offline — will sync automatically."
            : `${queuedCount} punches queued offline — will sync automatically.`}
        </p>
      )}

      {showDeniedBanner && (
        <p className={styles.banner} role="status">
          Location access was denied — your punch still went through, just without location.
        </p>
      )}

      {state.state === "CLOCKED_OUT" && (
        <>
          <p className={styles.label}>You&rsquo;re clocked out</p>
          <Button onClick={() => punchWithGeo("clock_in_user")} disabled={isPending}>
            Clock In
          </Button>
        </>
      )}

      {state.state !== "CLOCKED_OUT" && (
        <>
          <p className={styles.label}>Shift</p>
          <p className={`${styles.timer} tabular-nums`}>{shiftElapsed}</p>

          {state.state === "ON_CB" || state.state === "ON_LB" ? (
            <>
              <p className={styles.label}>{state.state === "ON_CB" ? "Break" : "Lunch"}</p>
              <p className={`${styles.timer} tabular-nums`}>{breakElapsed}</p>
              <Button
                onClick={() => punchSimple(state.state === "ON_CB" ? "end_cb" : "end_lb")}
                disabled={isPending}
              >
                {state.state === "ON_CB" ? "End Break" : "End Lunch"}
              </Button>
            </>
          ) : (
            <div className={styles.row}>
              <Button variant="secondary" onClick={() => punchSimple("start_cb")} disabled={isPending}>
                Start Break
              </Button>
              <Button variant="secondary" onClick={() => punchSimple("start_lb")} disabled={isPending}>
                Start Lunch
              </Button>
            </div>
          )}

          <Button variant="secondary" onClick={() => punchWithGeo("clock_out_user")} disabled={isPending}>
            Clock Out
          </Button>
        </>
      )}

      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}
