import { describe, expect, it, beforeEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runSyncWorker, SYNC_COMPLETED_EVENT } from "@/lib/offline/syncWorker";
import { enqueuePunch, getQueue } from "@/lib/offline/queue";

type RpcImpl = (fn: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>;

function fakeSupabase(rpc: RpcImpl): SupabaseClient {
  return { rpc } as unknown as SupabaseClient;
}

describe("runSyncWorker", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("does nothing when the queue is empty (no SYNC_COMPLETED_EVENT dispatched)", async () => {
    const supabase = fakeSupabase(async () => ({ data: "x", error: null }));
    let fired = false;
    const listener = () => {
      fired = true;
    };
    window.addEventListener(SYNC_COMPLETED_EVENT, listener);
    await runSyncWorker(supabase);
    window.removeEventListener(SYNC_COMPLETED_EVENT, listener);
    expect(fired).toBe(false);
  });

  it("dequeues on a successful replay", async () => {
    enqueuePunch("clock_in", 14.6, 120.9);
    const calls: string[] = [];
    const supabase = fakeSupabase(async (fn) => {
      calls.push(fn);
      return { data: "session-id", error: null };
    });

    await runSyncWorker(supabase);

    expect(getQueue()).toHaveLength(0);
    expect(calls).toEqual(["clock_in_user"]);
  });

  it("treats USER_ALREADY_CLOCKED_IN on a clock_in retry as idempotent success — no conflict logged", async () => {
    enqueuePunch("clock_in", null, null);
    const calls: string[] = [];
    const supabase = fakeSupabase(async (fn) => {
      calls.push(fn);
      if (fn === "clock_in_user") return { data: null, error: { message: "USER_ALREADY_CLOCKED_IN" } };
      throw new Error(`unexpected call: ${fn}`);
    });

    await runSyncWorker(supabase);

    expect(getQueue()).toHaveLength(0);
    expect(calls).toEqual(["clock_in_user"]);
  });

  it("treats NO_ACTIVE_SESSION on a clock_out retry as idempotent success — no conflict logged", async () => {
    enqueuePunch("clock_out", null, null);
    const calls: string[] = [];
    const supabase = fakeSupabase(async (fn) => {
      calls.push(fn);
      if (fn === "clock_out_user") return { data: null, error: { message: "NO_ACTIVE_SESSION" } };
      throw new Error(`unexpected call: ${fn}`);
    });

    await runSyncWorker(supabase);

    expect(getQueue()).toHaveLength(0);
    expect(calls).toEqual(["clock_out_user"]);
  });

  it("does NOT apply the idempotent rule to an unrelated error code", async () => {
    enqueuePunch("clock_in", null, null);
    const calls: { fn: string; args?: Record<string, unknown> }[] = [];
    const supabase = fakeSupabase(async (fn, args) => {
      calls.push({ fn, args });
      if (fn === "clock_in_user") return { data: null, error: { message: "ERR_VALIDATION" } };
      if (fn === "log_sync_conflict") return { data: "conflict-id", error: null };
      throw new Error(`unexpected call: ${fn}`);
    });

    await runSyncWorker(supabase);

    expect(getQueue()).toHaveLength(0);
    expect(calls.map((c) => c.fn)).toEqual(["clock_in_user", "log_sync_conflict"]);
  });

  it("logs a sync conflict for a genuine non-idempotent application error, then dequeues and continues", async () => {
    enqueuePunch("start_cb", null, null);
    enqueuePunch("end_lb", null, null);
    const calls: { fn: string; args?: Record<string, unknown> }[] = [];
    const supabase = fakeSupabase(async (fn, args) => {
      calls.push({ fn, args });
      if (fn === "start_cb") return { data: null, error: { message: "BREAK_ALREADY_OPEN" } };
      if (fn === "end_lb") return { data: "break-id", error: null };
      if (fn === "log_sync_conflict") return { data: "conflict-id", error: null };
      throw new Error(`unexpected call: ${fn}`);
    });

    await runSyncWorker(supabase);

    expect(getQueue()).toHaveLength(0);
    expect(calls.map((c) => c.fn)).toEqual(["start_cb", "log_sync_conflict", "end_lb"]);
    expect(calls[1].args?.p_failed_action).toBe("start_cb");
  });

  it("retries a network-shaped failure with backoff, then succeeds without a conflict", async () => {
    vi.useFakeTimers();
    try {
      enqueuePunch("end_cb", null, null);
      let attempts = 0;
      const calls: string[] = [];
      const supabase = fakeSupabase(async (fn) => {
        calls.push(fn);
        if (fn === "end_cb") {
          attempts += 1;
          if (attempts < 3) {
            throw new Error("Failed to fetch");
          }
          return { data: "break-id", error: null };
        }
        throw new Error(`unexpected call: ${fn}`);
      });

      const runPromise = runSyncWorker(supabase);
      await vi.runAllTimersAsync();
      await runPromise;

      expect(attempts).toBe(3);
      expect(calls).toEqual(["end_cb", "end_cb", "end_cb"]);
      expect(getQueue()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exhausts all 5 backoff attempts on a persistent network failure, then logs exactly one conflict", async () => {
    vi.useFakeTimers();
    try {
      enqueuePunch("start_lb", null, null);
      let attempts = 0;
      const calls: string[] = [];
      const supabase = fakeSupabase(async (fn) => {
        calls.push(fn);
        if (fn === "start_lb") {
          attempts += 1;
          throw new Error("Failed to fetch");
        }
        if (fn === "log_sync_conflict") return { data: "conflict-id", error: null };
        throw new Error(`unexpected call: ${fn}`);
      });

      const runPromise = runSyncWorker(supabase);
      await vi.runAllTimersAsync();
      await runPromise;

      expect(attempts).toBe(5);
      expect(calls.filter((fn) => fn === "log_sync_conflict")).toHaveLength(1);
      expect(getQueue()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispatches SYNC_COMPLETED_EVENT once after processing a non-empty queue", async () => {
    enqueuePunch("clock_in", null, null);
    const supabase = fakeSupabase(async () => ({ data: "x", error: null }));
    let fireCount = 0;
    const listener = () => {
      fireCount += 1;
    };
    window.addEventListener(SYNC_COMPLETED_EVENT, listener);

    await runSyncWorker(supabase);

    window.removeEventListener(SYNC_COMPLETED_EVENT, listener);
    expect(fireCount).toBe(1);
  });
});
