'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';

/**
 * The signed-in user's app role, for hiding admin-only UI (revenue figures,
 * Stripe, bulk delete).
 *
 * Presentation only. Every admin-only ACTION is re-checked server-side by
 * requireAdmin, and the tables themselves are gated by RLS — this hook just
 * keeps controls a worker cannot use from appearing in front of them.
 */
export function useMyRole() {
  const [role, setRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) {
        if (!cancelled) setLoading(false);
        return;
      }
      const { data } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', auth.user.id)
        .maybeSingle();
      if (!cancelled) {
        setRole(data?.role ?? null);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  return { role, isAdmin: role === 'admin', loading };
}
