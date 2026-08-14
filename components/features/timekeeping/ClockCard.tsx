"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { callRpc } from "@/lib/callRpc";
import { getGeolocation } from "@/lib/geolocation";
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

export function ClockCard() {
  const supabase = useMemo(() => createClient(), []);
  const [state, setState] = useState<ActiveSessionState | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDeniedBanner, setShowDeniedBanner] = useState(false);
  const [deniedShownThisSession, setDeniedShownThisSession] = useState(false);

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

  const shiftElapsed = useElapsedTime(state?.session?.clock_in_time ?? null);
  const breakElapsed = useElapsedTime(state?.active_break?.start_time ?? null);

  async function punchWithGeo(rpcName: "clock_in_user" | "clock_out_user") {
    setIsPending(true);
    setError(null);

    const geo = await getGeolocation();
    if (geo.status === "denied" && !deniedShownThisSession) {
      setShowDeniedBanner(true);
      setDeniedShownThisSession(true);
    }

    const { error: rpcError } = await callRpc(supabase, rpcName, {
      p_lat: geo.status === "checked" ? geo.lat : null,
      p_lng: geo.status === "checked" ? geo.lng : null,
      p_geo_status: geo.status,
    });

    if (rpcError) {
      setError(rpcError.message);
    }
    await refresh();
    setIsPending(false);
  }

  async function punchSimple(rpcName: "start_cb" | "end_cb" | "start_lb" | "end_lb") {
    setIsPending(true);
    setError(null);
    const { error: rpcError } = await callRpc(supabase, rpcName);
    if (rpcError) {
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
