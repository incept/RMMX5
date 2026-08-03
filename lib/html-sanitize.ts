// Defense-in-depth sanitizer for admin-authored email HTML (compose bodies and
// saved templates). It is NOT the primary XSS control:
//   - In the CRM, message bodies render inside a sandboxed <iframe> with no
//     `allow-scripts`, so injected script can't execute there.
//   - Outbound, the recipient's email client strips active content on its end.
// This pass hardens the middle: HTML that is stored and could one day be shown
// outside the sandbox, plus content pasted in from the web. Inputs are authored
// by admins, so a conservative string-level scrub (not a full HTML parser) is a
// proportionate belt-and-suspenders layer. Runs on both server and client, so
// it stays pure: no DOM, no dependencies, no `@/` imports.

// `<style>` is intentionally NOT here: designed HTML emails rely on it, and this
// pass also runs when saving admin-authored templates, so stripping it would
// mangle legitimate markup. CSS is inert in the sandboxed CRM iframe and is
// re-sanitized by the recipient's mail client, so keeping it is the safer trade.
const BLOCK_ELEMENTS = ['script', 'iframe', 'object', 'embed', 'noscript'];
const VOID_DANGEROUS = ['link', 'meta', 'base'];

/**
 * Strip executable and document-level constructs from an HTML fragment, leaving
 * ordinary formatting/links/images intact. Idempotent.
 */
export function sanitizeEmailHtml(input: string): string {
  if (!input) return '';
  let html = String(input);

  // 1. HTML comments: can hide conditional/`mso` payloads and split tags.
  html = html.replace(/<!--[\s\S]*?-->/g, '');

  // 2. Elements whose *content* is also unsafe: drop the whole subtree. The
  //    trailing `(?:<\/tag>|$)` also removes an unterminated block at EOF.
  for (const tag of BLOCK_ELEMENTS) {
    const block = new RegExp(`<${tag}\\b[\\s\\S]*?(?:<\\/${tag}\\s*>|$)`, 'gi');
    html = html.replace(block, '');
  }

  // 3. Standalone document-level tags (no meaningful content to keep).
  for (const tag of VOID_DANGEROUS) {
    html = html.replace(new RegExp(`<${tag}\\b[^>]*>`, 'gi'), '');
  }

  // 4. Inline event handlers: on*="...", on*='...', or on*=unquoted.
  html = html.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
  html = html.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
  html = html.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');

  // 5. Dangerous URL schemes in any attribute value. `data:` is allowed only
  //    for images (inert), never for scripts or other types.
  html = neutralizeUrls(html);

  return html;
}

// Collapse whitespace/entities an attacker could use to smuggle a scheme past a
// naive check (e.g. a TAB inside "javascript:" or a numeric entity), then blank
// the value if a forbidden scheme remains.
function neutralizeUrls(html: string): string {
  return html.replace(
    /\b(href|src|xlink:href|action|background|poster|formaction)\s*=\s*("([^"]*)"|'([^']*)')/gi,
    (match, attr, _q, dq, sq) => {
      const raw = dq ?? sq ?? '';
      const collapsed = raw
        .replace(/&#x?[0-9a-f]+;?/gi, '') // strip numeric entities
        .replace(/[\s-]+/g, '') // strip whitespace/control chars used to split a scheme
        .toLowerCase();
      const isBadScheme = /^(javascript|vbscript|file|about):/.test(collapsed);
      const isBadData =
        collapsed.startsWith('data:') && !/^data:image\/(png|jpe?g|gif|webp)/.test(collapsed);
      if (isBadScheme || isBadData) return `${attr}="#"`;
      return match;
    }
  );
}
