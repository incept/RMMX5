'use client';

import { createBrowserClient } from '@supabase/ssr';

// IMPORTANT: this file is compiled into the PUBLIC browser bundle, and Next
// inlines every process.env.NEXT_PUBLIC_* it references — including fallbacks.
// So it reads exactly ONE key variable and nothing else: if an old/poisoned
// variable were kept as a fallback here, its value (possibly a secret key)
// would be baked into the public JS even if never used at runtime.
//
//   NEXT_PUBLIC_SB_URL              https://<project-ref>.supabase.co
//   NEXT_PUBLIC_SB_PUBLISHABLE_KEY  sb_publishable_...  (NEVER sb_secret_)
//
// The name says the type on purpose — the publishable key is the only kind
// that may ever appear in a NEXT_PUBLIC_ variable. next.config.ts fails the
// build if this variable holds a secret key.

/** Supabase client for Client Components. Respects RLS as the logged-in user. */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SB_URL!,
    process.env.NEXT_PUBLIC_SB_PUBLISHABLE_KEY!
  );
}
