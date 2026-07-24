import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'RMMX5 — Crisis Management CRM',
  description:
    'Crisis-management CRM: reputation scoring, link tracking, email & SMS marketing, and client pipeline in one place.',
};

/**
 * Runs before first paint, so a dark-mode user never sees a white flash while
 * React hydrates. Mirrors applyTheme() in components/ThemeToggle.tsx; keep the
 * two in step. Wrapped in try/catch because localStorage throws outright when
 * cookies are blocked, and a theme preference is not worth a blank page.
 */
const THEME_SCRIPT = `
(function(){try{
  var t = localStorage.getItem('rmmx5-theme') || 'system';
  var d = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', d);
}catch(e){}})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The script above adds a class the server did not render, which is exactly
    // the mismatch suppressHydrationWarning exists for.
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
