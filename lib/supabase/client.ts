'use client';

import { createBrowserClient } from '@supabase/ssr';

/** Supabase client for Client Components. Respects RLS as the logged-in user. */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
