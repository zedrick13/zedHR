// RPC error codes in this app are always `RAISE EXCEPTION 'UPPER_SNAKE_CASE'`
// (see lib/callRpc.ts). A callRpc() error whose code doesn't look like that
// came from the network/transport layer instead (a dropped connection, a
// timeout, "Failed to fetch", ...) rather than a definitive server
// response — that's the only case worth retrying with backoff.
export function isApplicationErrorCode(code: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(code);
}
