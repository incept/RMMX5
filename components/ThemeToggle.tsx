'use client';

import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark' | 'system';

export const THEME_KEY = 'rmmx5-theme';

/**
 * Applies a theme choice to the document.
 *
 * Kept in sync with the pre-hydration script in app/layout.tsx — that script
 * runs the same logic before first paint so the page never flashes white on
 * the way to dark. If the class-toggling rule changes here, change it there.
 */
export function applyTheme(theme: Theme) {
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

const OPTIONS: { value: Theme; label: string; icon: string }[] = [
  // Sun
  {
    value: 'light',
    label: 'Light',
    icon: 'M12 17a5 5 0 100-10 5 5 0 000 10zM12 1v2m0 18v2M4.2 4.2l1.4 1.4m12.8 12.8l1.4 1.4M1 12h2m18 0h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  },
  // Moon
  { value: 'dark', label: 'Dark', icon: 'M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z' },
  // Monitor
  {
    value: 'system',
    label: 'System',
    icon: 'M3 4h18v12H3zM8 20h8m-4-4v4',
  },
];

/** Segmented Light / Dark / System control. Persists the choice to localStorage. */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');

  // The document class is already correct (set pre-hydration); this only syncs
  // the control's own highlighted state to what was stored.
  useEffect(() => {
    const stored = localStorage.getItem(THEME_KEY) as Theme | null;
    if (stored === 'light' || stored === 'dark' || stored === 'system') setTheme(stored);
  }, []);

  // On "system", follow the OS if it changes while the app is open.
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  function choose(next: Theme) {
    setTheme(next);
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  }

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="flex items-center gap-0.5 rounded-lg border border-gray-200 p-0.5"
    >
      {OPTIONS.map((option) => {
        const active = theme === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={option.label}
            onClick={() => choose(option.value)}
            className={`flex flex-1 items-center justify-center rounded-md py-1 transition-colors ${
              active ? 'bg-brand-50 text-brand-700' : 'text-gray-400 hover:bg-gray-100'
            }`}
          >
            <svg
              viewBox="0 0 24 24"
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d={option.icon} />
            </svg>
            <span className="sr-only">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
