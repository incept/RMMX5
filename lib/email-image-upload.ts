// Client helper: upload an inline email image and get back its public URL.
// Shared by every compose surface so they hit the same validated, admin-gated
// endpoint (app/api/email/images). Throws with the server's message on failure
// so RichTextEditor can surface it.
export async function uploadEmailImage(file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/email/images', { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}) as { url?: string; error?: string });
  if (!res.ok || !body.url) {
    throw new Error(body.error || 'Image upload failed');
  }
  return body.url;
}
