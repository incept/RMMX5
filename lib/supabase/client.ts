'use client';

import { createBrowserClient } from '@supabase/ssr';

// NEXT_PUBLIC_SB_* are the preferred names: the Hostinger build environment
// kept injecting stale values under the standard NEXT_PUBLIC_SUPABASE_* names
// at build time, overriding every panel/file edit. Fresh names sidestep that;
// the old names remain as a fallback for local dev.
export const SB_URL =
  process.env.NEXT_PUBLIC_SB_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!;
export const SB_ANON_KEY =
  process.env.NEXT_PUBLIC_SB_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/** Supabase client for Client Components. Respects RLS as the logged-in user. */
export function createClient() {
  return createBrowserClient(SB_URL, SB_ANON_KEY);
}
