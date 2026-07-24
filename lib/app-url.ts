// Base URL used to build absolute links back into this app — currently the
// open-tracking pixel and click-tracking links in outbound email.
//
// Resolution order:
//   1. APP_BASE_URL          — preferred. A plain (non-NEXT_PUBLIC) server var,
//                              read at RUNTIME, so it is NOT frozen into the
//                              build the way NEXT_PUBLIC_* values are. This is
//                              what dodges the host's stuck-build-env problem:
//                              set it and it takes effect on the next request,
//                              no rebuild needed.
//   2. NEXT_PUBLIC_APP_URL   — legacy build-time var, kept for compatibility.
//   3. DEFAULT_APP_URL       — hardcoded production origin, so tracking links
//                              are still correct even with zero env config.
//
// It is only ever read server-side (email-send.ts), so it does not need the
// NEXT_PUBLIC_ prefix. When the production domain changes, update the default
// here (or set APP_BASE_URL) — it must have no trailing slash.
const DEFAULT_APP_URL = 'https://app2.removemymugshot.org';

export function appBaseUrl(): string {
  const raw =
    process.env.APP_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? DEFAULT_APP_URL;
  return raw.replace(/\/+$/, '');
}
