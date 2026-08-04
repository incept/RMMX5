import type { LinkPlaceholder } from '@/components/RichTextEditor';

/**
 * Per-contact removal-link placeholders offered in the template / sequence /
 * compose editors; they resolve to each recipient's link URLs at send time
 * (see lib/link-placeholders.ts for the send-time substitution). Shared so the
 * Email Marketing hub, the inbox, and the contact panel all offer the same set.
 */
export const LINK_PLACEHOLDERS: LinkPlaceholder[] = [
  ...Array.from({ length: 14 }, (_, i) => ({
    label: `Removal link ${i + 1}`,
    token: `{{link${i + 1}}}`,
  })),
  { label: 'All live links', token: '{{links}}', asLink: false },
];
