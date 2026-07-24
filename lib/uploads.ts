export const CONTACT_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const VOICEMAIL_MAX_BYTES = 25 * 1024 * 1024;

const ACTIVE_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/javascript',
  'text/javascript',
]);

export function validateContactFile(file: File): string | null {
  if (!file.name || file.size <= 0) return 'A non-empty file is required';
  if (file.size > CONTACT_FILE_MAX_BYTES) return 'Files must be 10 MB or smaller';
  if (ACTIVE_CONTENT_TYPES.has(file.type.toLowerCase())) {
    return 'HTML, SVG, and JavaScript files are not allowed';
  }
  return null;
}

export function validateVoicemailFile(file: File): string | null {
  if (!file.name || file.size <= 0) return 'A non-empty audio file is required';
  if (file.size > VOICEMAIL_MAX_BYTES) return 'Voicemail audio must be 25 MB or smaller';
  if (!file.type.toLowerCase().startsWith('audio/')) return 'An audio file is required';
  return null;
}

export function storageSafeName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-180);
  return sanitized || 'upload';
}
