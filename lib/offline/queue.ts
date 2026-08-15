// SPEC.md §8.1 offline punch queue. localStorage schema per the spec:
// `punch_queue` items `{ id, action, payload: { attempted_timestamp, lat, lng } }`.
// geo_status isn't in that schema — it's derived at sync time from whether
// lat/lng are present (see syncWorker.ts), a flagged simplification since
// the minimal payload can't distinguish "denied" from "unavailable" the
// way a live punch's geolocation.ts result can.

export type PunchAction = "clock_in" | "clock_out" | "start_cb" | "end_cb" | "start_lb" | "end_lb";

export type QueuedPunch = {
  id: string;
  action: PunchAction;
  payload: {
    attempted_timestamp: string;
    lat: number | null;
    lng: number | null;
  };
};

const QUEUE_KEY = "zedhr_punch_queue";
const OFFLINE_SINCE_KEY = "zedhr_offline_since";
export const PUNCH_QUEUE_CHANGED_EVENT = "zedhr:punch-queue-changed";

function hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

function dispatchQueueChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(PUNCH_QUEUE_CHANGED_EVENT));
  }
}

function readQueue(): QueuedPunch[] {
  if (!hasLocalStorage()) return [];
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedPunch[]) : [];
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedPunch[]): void {
  if (!hasLocalStorage()) return;
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export function getQueue(): QueuedPunch[] {
  return readQueue();
}

export function enqueuePunch(action: PunchAction, lat: number | null, lng: number | null): QueuedPunch {
  const item: QueuedPunch = {
    id: crypto.randomUUID(),
    action,
    payload: { attempted_timestamp: new Date().toISOString(), lat, lng },
  };
  const queue = readQueue();
  queue.push(item);
  writeQueue(queue);

  if (hasLocalStorage() && localStorage.getItem(OFFLINE_SINCE_KEY) === null) {
    localStorage.setItem(OFFLINE_SINCE_KEY, new Date().toISOString());
  }

  dispatchQueueChanged();
  return item;
}

export function removeFromQueue(id: string): void {
  writeQueue(readQueue().filter((item) => item.id !== id));
  if (readQueue().length === 0 && hasLocalStorage()) {
    localStorage.removeItem(OFFLINE_SINCE_KEY);
  }
  dispatchQueueChanged();
}

/** Seconds since the queue's first item was enqueued (0 if nothing queued yet). */
export function getOfflineDurationSeconds(): number {
  if (!hasLocalStorage()) return 0;
  const since = localStorage.getItem(OFFLINE_SINCE_KEY);
  if (!since) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
}
