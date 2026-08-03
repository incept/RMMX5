export const CONTACT_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const VOICEMAIL_MAX_BYTES = 25 * 1024 * 1024;
export const EMAIL_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const EMAIL_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const ACTIVE_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/javascript',
  'text/javascript',
]);
const ACTIVE_EXTENSIONS = /\.(?:html?|xhtml|svg|js|mjs|cjs|xml)$/i;

export function validateContactFile(file: File): string | null {
  if (!file.name || file.size <= 0) return 'A non-empty file is required';
  if (file.size > CONTACT_FILE_MAX_BYTES) return 'Files must be 10 MB or smaller';
  if (ACTIVE_EXTENSIONS.test(file.name)) {
    return 'HTML, SVG, XML, and JavaScript files are not allowed';
  }
  if (ACTIVE_CONTENT_TYPES.has(file.type.toLowerCase())) {
    return 'HTML, SVG, and JavaScript files are not allowed';
  }
  return null;
}

function startsWith(bytes: Uint8Array, expected: number[]): boolean {
  return expected.every((value, index) => bytes[index] === value);
}

/** Verifies common formats against their bytes instead of trusting browser MIME metadata. */
export async function validateContactFileContent(file: File): Promise<string | null> {
  const basic = validateContactFile(file);
  if (basic) return basic;
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const type = file.type.toLowerCase();
  const mismatch =
    (type === 'application/pdf' && !startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) ||
    (type === 'image/png' && !startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) ||
    (type === 'image/jpeg' && !startsWith(bytes, [0xff, 0xd8, 0xff])) ||
    (type === 'image/gif' &&
      !startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) &&
      !startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]));
  return mismatch ? 'File contents do not match the declared file type' : null;
}

/**
 * Validate an image destined for the public email-assets bucket. Restricted to
 * raster formats (no SVG — it can carry script) and verified against magic bytes
 * so a renamed file can't slip through on its declared MIME type alone.
 */
export async function validateEmailImage(file: File): Promise<string | null> {
  if (!file.name || file.size <= 0) return 'A non-empty image file is required';
  if (file.size > EMAIL_IMAGE_MAX_BYTES) return 'Images must be 5 MB or smaller';
  const type = file.type.toLowerCase();
  if (!EMAIL_IMAGE_TYPES.has(type)) return 'Only PNG, JPEG, GIF, or WebP images are allowed';
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const ok =
    (type === 'image/png' && startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) ||
    (type === 'image/jpeg' && startsWith(bytes, [0xff, 0xd8, 0xff])) ||
    (type === 'image/gif' &&
      (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
        startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))) ||
    (type === 'image/webp' &&
      startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP');
  return ok ? null : 'Image contents do not match the declared file type';
}

export function validateVoicemailFile(file: File): string | null {
  if (!file.name || file.size <= 0) return 'A non-empty audio file is required';
  if (file.size > VOICEMAIL_MAX_BYTES) return 'Voicemail audio must be 25 MB or smaller';
  if (!file.type.toLowerCase().startsWith('audio/')) return 'An audio file is required';
  return null;
}

export async function validateVoicemailFileContent(file: File): Promise<string | null> {
  const basic = validateVoicemailFile(file);
  if (basic) return basic;
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const type = file.type.toLowerCase();
  const isMp3 =
    startsWith(bytes, [0x49, 0x44, 0x33]) ||
    (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  const isWave =
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WAVE';
  const isOgg = startsWith(bytes, [0x4f, 0x67, 0x67, 0x53]);
  const isMp4 = String.fromCharCode(...bytes.slice(4, 8)) === 'ftyp';
  if (
    (type.includes('mpeg') && !isMp3) ||
    (type.includes('wav') && !isWave) ||
    (type.includes('ogg') && !isOgg) ||
    ((type.includes('mp4') || type.includes('m4a')) && !isMp4)
  ) {
    return 'Audio contents do not match the declared file type';
  }
  return null;
}

export function storageSafeName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-180);
  return sanitized || 'upload';
}
