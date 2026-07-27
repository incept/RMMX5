'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import ThemeToggle from '@/components/ThemeToggle';

interface Leaf {
  href: string;
  label: string;
}
interface Section {
  id: string;
  label: string;
  adminOnly?: boolean;
  children: Leaf[];
}

/**
 * Airtable-style nested tree: top-level leaves plus collapsible sections
 * whose children hang off an indent guide line. Expansion state persists;
 * the section owning the active route force-opens so navigation never
 * lands on a hidden item.
 */
const TOP: Leaf[] = [{ href: '/dashboard', label: 'Dashboard' }];

const SECTIONS: Section[] = [
  {
    id: 'crm',
    label: 'CRM',
    children: [
      { href: '/contacts', label: 'Contacts' },
      { href: '/clients', label: 'Clients' },
      { href: '/vendors', label: 'Vendors' },
      { href: '/import', label: 'Import' },
    ],
  },
  {
    id: 'outreach',
    label: 'Outreach',
    children: [
      { href: '/inbox', label: 'Inbox' },
      { href: '/marketing', label: 'Email Marketing' },
      { href: '/sms', label: 'SMS' },
      { href: '/voicemail', label: 'Voicemail' },
    ],
  },
  {
    id: 'admin',
    label: 'Admin',
    adminOnly: true,
    children: [
      { href: '/admin/users', label: 'Users' },
      { href: '/admin/pipeline', label: 'Statuses & Stages' },
      { href: '/admin/fields', label: 'Custom Fields' },
      { href: '/admin/url-rules', label: 'URL Rules & Scoring' },
      { href: '/admin/notifications', label: 'Notifications' },
      { href: '/admin/integrations', label: 'Integrations & APIs' },
      { href: '/admin/debug', label: 'Debug Log' },
    ],
  },
];

const OPEN_LS = 'rmmx5-nav-open';

export default function Sidebar({ role, userName }: { role: string; userName: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState<Record<string, boolean>>({ crm: true, outreach: true, admin: false });

  useEffect(() => {
    try {
      const saved = localStorage.getItem(OPEN_LS);
      if (saved) setOpen((o) => ({ ...o, ...JSON.parse(saved) }));
    } catch {
      /* defaults are fine */
    }
  }, []);

  function toggle(id: string) {
    setOpen((o) => {
      const next = { ...o, [id]: !o[id] };
      localStorage.setItem(OPEN_LS, JSON.stringify(next));
      return next;
    });
  }

  async function signOut() {
    await createClient().auth.signOut();
    router.push('/');
    router.refresh();
  }

  const isActive = (href: string) => pathname.startsWith(href);

  const leafRow = (item: Leaf, nested: boolean) => {
    const active = isActive(item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        className={`mb-px flex items-center rounded-lg py-1.5 text-sm transition-colors ${
          nested ? 'px-3' : 'px-3 font-medium'
        } ${
          active
            ? 'bg-brand-50 font-medium text-brand-700'
            : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
        }`}
      >
        {item.label}
      </Link>
    );
  };

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-gray-200 bg-white">
      <div className="flex items-center px-4 py-4">
        <span className="text-sm font-light tracking-[0.14em]">RMM-R1S</span>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 pb-4">
        {TOP.map((item) => leafRow(item, false))}

        {/* Same set of roles requireAdmin and useMyRole accept — the nav's own
            literal check once hid this menu from the super administrator. */}
        {SECTIONS.filter((s) => !s.adminOnly || ['admin', 'super_admin'].includes(role)).map((section) => {
          // The active route's section can't be collapsed shut behind the
          // user's back — it renders open regardless of the saved state.
          const containsActive = section.children.some((c) => isActive(c.href));
          const expanded = open[section.id] || containsActive;
          return (
            <div key={section.id} className="mt-1">
              <button
                onClick={() => toggle(section.id)}
                className="flex w-full items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold text-gray-700 transition-colors hover:bg-gray-100"
              >
                <svg
                  viewBox="0 0 16 16"
                  className={`h-3 w-3 shrink-0 text-gray-400 transition-transform ${
                    expanded ? 'rotate-90' : ''
                  }`}
                  fill="currentColor"
                >
                  <path d="M6 3l5 5-5 5V3z" />
                </svg>
                {section.label}
              </button>
              {expanded && (
                <div className="mt-0.5 mb-1 ml-[17px] border-l border-gray-200 pl-2">
                  {section.children.map((item) => leafRow(item, true))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      <div className="border-t border-gray-200 px-4 py-3">
        <ThemeToggle />
        <div className="mt-3 truncate text-xs font-medium text-gray-700">{userName}</div>
        <div className="mb-2 text-[10px] text-gray-400 uppercase">{role.replace('_', ' ')}</div>
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
