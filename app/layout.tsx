import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'RMMX5 — Crisis Management CRM',
  description:
    'Crisis-management CRM: reputation scoring, link tracking, email & SMS marketing, and client pipeline in one place.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
