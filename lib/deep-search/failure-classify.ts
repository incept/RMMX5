// Pure classifier for probe-failure reasons — deliberately import-free (no '@/'
// aliases, no deps) so it can be unit-tested directly.
//
// Distinguishes a source that is entirely UNREACHABLE (a DNS or connection
// failure — the whole site is down) from a page that merely could not be read.
// A flaky host being down is transient and re-running does not help until it is
// back, so the deep search reports it neutrally instead of as a "needs a re-run"
// fault. Read timeouts are deliberately EXCLUDED: a slow page can still be worth
// another run, so it stays a normal partial.
export function isUnreachableFailure(reason: string): boolean {
  return /\b(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENETDOWN)\b|getaddrinfo/i.test(
    reason ?? ''
  );
}
