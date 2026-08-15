import { describe, expect, it, beforeEach } from "vitest";
import {
  enqueuePunch,
  getOfflineDurationSeconds,
  getQueue,
  PUNCH_QUEUE_CHANGED_EVENT,
  removeFromQueue,
} from "@/lib/offline/queue";

describe("lib/offline/queue", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("enqueues a punch and persists it with an attempted_timestamp", () => {
    const item = enqueuePunch("clock_in", 14.6, 120.9);
    expect(getQueue()).toHaveLength(1);
    expect(getQueue()[0]).toEqual(item);
    expect(item.payload.lat).toBe(14.6);
    expect(item.payload.lng).toBe(120.9);
    expect(typeof item.payload.attempted_timestamp).toBe("string");
  });

  it("supports null lat/lng (no GPS fix)", () => {
    const item = enqueuePunch("start_cb", null, null);
    expect(item.payload.lat).toBeNull();
    expect(item.payload.lng).toBeNull();
  });

  it("preserves FIFO order across multiple enqueues", () => {
    enqueuePunch("clock_in", null, null);
    enqueuePunch("start_cb", null, null);
    enqueuePunch("end_cb", null, null);
    expect(getQueue().map((item) => item.action)).toEqual(["clock_in", "start_cb", "end_cb"]);
  });

  it("removes an item by id, leaving the rest intact", () => {
    const first = enqueuePunch("clock_in", null, null);
    const second = enqueuePunch("clock_out", null, null);
    removeFromQueue(first.id);
    expect(getQueue()).toEqual([second]);
  });

  it("tracks offline duration from the first enqueue, clears once the queue drains", () => {
    expect(getOfflineDurationSeconds()).toBe(0);
    const item = enqueuePunch("start_lb", null, null);
    expect(getOfflineDurationSeconds()).toBeGreaterThanOrEqual(0);
    removeFromQueue(item.id);
    expect(getOfflineDurationSeconds()).toBe(0);
  });

  it("dispatches a change event on enqueue and on dequeue", () => {
    let changeCount = 0;
    const listener = () => {
      changeCount += 1;
    };
    window.addEventListener(PUNCH_QUEUE_CHANGED_EVENT, listener);

    const item = enqueuePunch("end_lb", null, null);
    removeFromQueue(item.id);

    window.removeEventListener(PUNCH_QUEUE_CHANGED_EVENT, listener);
    expect(changeCount).toBe(2);
  });
});
