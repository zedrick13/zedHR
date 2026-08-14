export type GeoResult =
  | { status: "checked"; lat: number; lng: number }
  | { status: "denied" }
  | { status: "unavailable" };

// SPEC §5.2/M3: 5s timeout; missing/denied GPS never blocks a punch — the
// caller always gets a result, never a rejection.
//
// The `timeout` option passed to getCurrentPosition only bounds the wait for
// a position *fix* once permission is decided — if the user leaves the
// browser's permission prompt unanswered, getCurrentPosition can hang
// indefinitely regardless of that option (confirmed: headless Chromium with
// no permission grant never calls either callback). An outer race is the
// only way to guarantee this function always settles.
export function getGeolocation(): Promise<GeoResult> {
  if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
    return Promise.resolve({ status: "unavailable" });
  }

  const geolocationResult = new Promise<GeoResult>((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          status: "checked",
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        });
      },
      (error) => {
        resolve(error.code === error.PERMISSION_DENIED ? { status: "denied" } : { status: "unavailable" });
      },
      { timeout: 5000, maximumAge: 0 },
    );
  });

  const outerTimeout = new Promise<GeoResult>((resolve) => {
    setTimeout(() => resolve({ status: "unavailable" }), 6000);
  });

  return Promise.race([geolocationResult, outerTimeout]);
}
