'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import ThemeToggle from '@/components/ThemeToggle';

const NAV = [
  { href: '/dashboard', label: 'Dashboard', icon: 'M3 13h4v8H3zM10 9h4v12h-4zM17 4h4v17h-4z' },
  { href: '/contacts', label: 'Contacts', icon: 'M12 12a4 4 0 100-8 4 4 0 000 8zm0 2c-4 0-8 2-8 5v1h16v-1c0-3-4-5-8-5z' },
  { href: '/clients', label: 'Clients', icon: 'M12 2l2.4 5.3L20 8l-4 4 1 5.7-5-2.7-5 2.7 1-5.7-4-4 5.6-.7z' },
  { href: '/inbox', label: 'Inbox', icon: 'M3 5h18v14H3zm0 0l9 7 9-7' },
  { href: '/marketing', label: 'Email Marketing', icon: 'M3 8l9 6 9-6M3 8v10h18V8M3 8l9-4 9 4' },
  { href: '/sms', label: 'SMS', icon: 'M4 4h16v12H8l-4 4z' },
  { href: '/voicemail', label: 'Voicemail', icon: 'M6 14a3 3 0 110-6 3 3 0 010 6zm12 0a3 3 0 110-6 3 3 0 010 6zM6 14h12' },
  { href: '/vendors', label: 'Vendors', icon: 'M3 7h18l-2 12H5zM8 7V5a4 4 0 018 0v2' },
  { href: '/import', label: 'Import', icon: 'M12 3v12m0 0l-4-4m4 4l4-4M4 21h16' },
];

const ADMIN_NAV = [
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/pipeline', label: 'Statuses & Stages' },
  { href: '/admin/fields', label: 'Custom Fields' },
  { href: '/admin/url-rules', label: 'URL Rules & Scoring' },
  { href: '/admin/notifications', label: 'Notifications' },
  { href: '/admin/integrations', label: 'Integrations & APIs' },
  { href: '/admin/debug', label: 'Debug Log' },
];

export default function Sidebar({ role, userName }: { role: string; userName: string }) {
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    await createClient().auth.signOut();
    router.push('/');
    router.refresh();
  }

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-gray-200 bg-white">
      <div className="flex items-center gap-2 px-4 py-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-600 text-xs font-bold text-white">
          R5
        </div>
        <span className="text-sm font-bold tracking-wide">RMMX5</span>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        {NAV.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`mb-0.5 flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                active ? 'bg-brand-50 text-brand-700' : 'text-gray-600 hover:bg-gray-100'
              }`}
            >
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4 shrink-0"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d={item.icon} />
              </svg>
              {item.label}
            </Link>
          );
        })}

        {role === 'admin' && (
          <>
            <div className="mt-5 mb-1 px-3 text-[10px] font-bold tracking-widest text-gray-400 uppercase">
              Admin
            </div>
            {ADMIN_NAV.map((item) => {
              const active = pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`mb-0.5 block rounded-lg px-3 py-1.5 text-sm transition-colors ${
                    active ? 'bg-brand-50 font-medium text-brand-700' : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </>
        )}
      </nav>

      <div className="border-t border-gray-200 px-4 py-3">
        <ThemeToggle />
        <div className="mt-3 truncate text-xs font-medium text-gray-700">{userName}</div>
        <div className="mb-2 text-[10px] text-gray-400 uppercase">{role}</div>
        <div className="flex items-center gap-3">
          <Link href="/profile" className="text-xs text-gray-500 hover:text-brand-700">
            My profile
          </Link>
          <button onClick={signOut} className="text-xs text-gray-500 hover:text-red-600">
            Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}
