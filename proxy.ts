import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Runs on every matched request (Next 16's replacement for middleware.ts):
 * refreshes the Supabase session cookie and bounces unauthenticated
 * visitors back to the landing page. Admin-only areas are re-checked
 * authoritatively in layouts and API guards — this is just the fast bounce.
 */
export default async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SB_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SB_PUBLISHABLE_KEY ??
      process.env.NEXT_PUBLIC_SB_ANON_KEY ??
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // Local JWT verification instead of a network hit to the Auth server on
  // every request (getClaims still refreshes an expired session, which is the
  // other job this proxy exists to do). Roles/status stay enforced by RLS and
  // the API guards — this is only the fast bounce.
  const { data } = await supabase.auth.getClaims();
  const user = data?.claims?.sub ? { id: data.claims.sub as string } : null;

  const { pathname } = request.nextUrl;
  const isPublic = pathname === '/' || pathname.startsWith('/auth');

  if (!user && !isPublic) {
    return NextResponse.redirect(new URL('/', request.url));
  }
  if (user && pathname === '/') {
    // Disabled identities may still have a valid Supabase session. Only active
    // profiles should be redirected into the authenticated shell.
    const { data: profile } = await supabase
      .from('profiles')
      .select('status')
      .eq('id', user.id)
      .maybeSingle();
    if (profile?.status === 'active') {
      return NextResponse.redirect(new URL('/dashboard', request.url));
    }
  }

  return response;
}

export const config = {
  // Skip static assets and the endpoints that must work without a session:
  // tracking pixel/click, inbound webhooks, and the cron tick (secret-gated).
  matcher: ['/((?!_next/static|_next/image|favicon\\.ico|api/track|api/webhooks|api/cron).*)'],
};
