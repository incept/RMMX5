/**
 * Wraps a message body in a minimal HTML document whose base styles track the
 * app theme, so a stored message reads as part of the CRM instead of the bare
 * white / black / serif block a raw fragment renders as. Meant to be dropped
 * into a sandboxed iframe (no scripts), so mail that ships its own styling
 * renders as the sender built it — only the frame's defaults change.
 *
 * Shared by the unified inbox and the contact panel's sent-email viewer so both
 * surfaces render a message identically.
 *
 * blockImages restricts images to inline data: URIs (remote images and 1x1
 * tracking pixels can't phone home on open); pair it with the iframe sandbox,
 * which already blocks scripts.
 */
export function framedEmail(html: string, dark: boolean, blockImages: boolean): string {
  const bg = dark ? '#282c34' : '#ffffff'; // --color-surface, both themes
  const fg = dark ? '#f0f2f5' : '#111827'; // gray-900, both themes
  const link = dark ? '#a5b4fc' : '#4f46e5';
  const rule = dark ? '#474d59' : '#e5e7eb';
  const muted = dark ? '#b4bac3' : '#6b7280';
  const csp = blockImages
    ? '<meta http-equiv="Content-Security-Policy" content="img-src data:;">'
    : '';
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${csp}
<base target="_blank">
<style>
  :root { color-scheme: ${dark ? 'dark' : 'light'}; }
  html, body { margin: 0; }
  body {
    padding: 12px;
    background: ${bg};
    color: ${fg};
    font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.55;
    overflow-wrap: break-word;
  }
  a { color: ${link}; }
  img, table { max-width: 100%; }
  table { border-collapse: collapse; }
  blockquote {
    margin: 0 0 0 0.8em;
    padding-left: 0.8em;
    border-left: 3px solid ${rule};
    color: ${muted};
  }
</style></head><body>${html}</body></html>`;
}
