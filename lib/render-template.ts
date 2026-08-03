// Pure, dependency-free template rendering shared by the server (sequence
// runner, send route) and the client (compose windows, template editor). Kept
// out of sequence-runner.ts so client components can import it without pulling
// in server-only modules (the admin Supabase client, nodemailer, etc.).

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Render {{placeholders}} against a contact row.
 *
 * `html: true` escapes the SUBSTITUTED VALUES (never the template itself —
 * the admin's markup is trusted). Contact fields are attacker-supplied: a
 * form submission with `<a href=...>` in the name would otherwise be mailed
 * out as live markup under our sending domain. Subjects and SMS bodies are
 * plain text, so they render unescaped.
 */
export function renderTemplate(
  text: string,
  contact: Record<string, any>,
  opts?: { html?: boolean }
): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) => {
    const value = contact[key] ?? contact.custom?.[key] ?? '';
    const str = value == null ? '' : String(value);
    return opts?.html ? str.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]) : str;
  });
}
