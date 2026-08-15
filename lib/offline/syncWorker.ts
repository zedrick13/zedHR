import type { SupabaseClient } from "@supabase/supabase-js";
import { callRpc, type ErrorEnvelope } from "@/lib/callRpc";
import { getOfflineDurationSeconds, getQueue, removeFromQueue, type PunchAction, type QueuedPunch } from "./queue";
import { isApplicationErrorCode } from "./networkError";

export const SYNC_COMPLETED_EVENT = "zedhr:sync-completed";

// SPEC.md §8.1: exponential backoff 2s -> 32s, 5 attempts.
const BACKOFF_MS = [2000, 4000, 8000, 16000, 32000];

// CLAUDE.md invariant #11 / SPEC.md §2.3: ONLY the offline sync worker
// treats these as success-and-dequeue (the "successful call, lost
// response" case) — live UI calls always surface them as real errors.
const IDEMPOTENT_SUCCESS_CODE: Partial<Record<PunchAction, string>> = {
  clock_in: "USER_ALREADY_CLOCKED_IN",
  clock_out: "NO_ACTIVE_SESSION",
};

const RPC_NAME: Record<PunchAction, string> = {
  clock_in: "clock_in_user",
  clock_out: "clock_out_user",
  start_cb: "start_cb",
  end_cb: "end_cb",
  start_lb: "start_lb",
  end_lb: "end_lb",
};

function geoStatusFor(payload: QueuedPunch["payload"]): "checked" | "unavailable" {
  return payload.lat !== null && payload.lng !== null ? "checked" : "unavailable";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callPunchRpc(
  supabase: SupabaseClient,
  item: QueuedPunch,
  offlineDurationSeconds: number,
): Promise<{ data: unknown; error: ErrorEnvelope | null }> {
  const common = {
    p_attempted_timestamp: item.payload.attempted_timestamp,
    p_offline_duration_seconds: offlineDurationSeconds,
  };

  if (item.action === "clock_in" || item.action === "clock_out") {
    return callRpc(supabase, RPC_NAME[item.action], {
      p_lat: item.payload.lat,
      p_lng: item.payload.lng,
      p_geo_status: geoStatusFor(item.payload),
      ...common,
    });
  }
  return callRpc(supabase, RPC_NAME[item.action], common);
}

// Deliberately lowercase: isApplicationErrorCode() requires an all-caps
// RAISE EXCEPTION-shaped code to stop retrying. A network failure — thrown
// exception or otherwise — must never accidentally look like a clean
// application response, or the backoff loop gives up after one attempt.
const NETWORK_FAILURE_CODE = "network_error";

async function attemptWithBackoff(
  supabase: SupabaseClient,
  item: QueuedPunch,
  offlineDurationSeconds: number,
): Promise<{ data: unknown; error: ErrorEnvelope | null }> {
  let result: { data: unknown; error: ErrorEnvelope | null } = {
    data: null,
    error: { code: NETWORK_FAILURE_CODE, message: "Sync failed after retries.", http_status: 0 },
  };

  for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
    try {
      result = await callPunchRpc(supabase, item, offlineDurationSeconds);
    } catch {
      result = { data: null, error: { code: NETWORK_FAILURE_CODE, message: "Network error.", http_status: 0 } };
    }

    // A definitive response (success, or a clean application error code)
    // won't change on retry — only a transport-level failure is worth
    // backing off and trying again.
    if (result.error === null || isApplicationErrorCode(result.error.code)) {
      return result;
    }
    if (attempt < BACKOFF_MS.length - 1) {
      await sleep(BACKOFF_MS[attempt]);
    }
  }

  return result;
}

// The `online` event can fire more than once in quick succession (a flaky
// reconnect, or — as caught by a Playwright test — a component mount check
// and an `online` listener both firing close together), and OfflineSyncListener
// is mounted once per authenticated page. Without this guard, two
// concurrent runs can both read the same still-queued item before either
// has dequeued it and each report their own conflict for the same item.
let isSyncing = false;

/**
 * Sequentially replays the offline punch queue (SPEC.md §8.1). Runs on the
 * `online` event; safe to call when the queue is empty, the app never went
 * offline, or a sync is already in progress. Continues past a single
 * item's failure rather than blocking the rest of the queue.
 */
export async function runSyncWorker(supabase: SupabaseClient): Promise<void> {
  if (isSyncing) return;

  const queue = getQueue();
  if (queue.length === 0) return;

  isSyncing = true;
  try {
    await drainQueue(supabase, queue);
  } finally {
    isSyncing = false;
  }
}

async function drainQueue(supabase: SupabaseClient, queue: QueuedPunch[]): Promise<void> {
  const offlineDurationSeconds = getOfflineDurationSeconds();

  for (const item of queue) {
    const result = await attemptWithBackoff(supabase, item, offlineDurationSeconds);

    if (result.error === null) {
      removeFromQueue(item.id);
      continue;
    }

    const idempotentCode = IDEMPOTENT_SUCCESS_CODE[item.action];
    if (idempotentCode && result.error.code === idempotentCode) {
      removeFromQueue(item.id);
      continue;
    }

    // Genuine, non-idempotent failure: record it for manager review and
    // move on rather than blocking the rest of the queue. Best-effort —
    // if reporting the conflict itself fails (e.g. still offline), don't
    // let that abort the rest of the queue either; the item is dropped
    // either way since retrying it indefinitely isn't safe.
    try {
      await callRpc(supabase, "log_sync_conflict", {
        p_failed_action: item.action,
        p_details: { error_code: result.error.code, payload: item.payload },
      });
    } catch {
      // Nothing more we can do client-side; move on to the next item.
    }
    removeFromQueue(item.id);
  }

  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(SYNC_COMPLETED_EVENT));
  }
}
