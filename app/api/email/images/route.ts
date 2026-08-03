import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { EMAIL_IMAGE_MAX_BYTES, storageSafeName, validateEmailImage } from '@/lib/uploads';
import { enforceDeclaredLength } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';

export const runtime = 'nodejs';

const BUCKET = 'email-assets';

/**
 * Upload an inline email image and return its public URL. Gated to admins (the
 * only role that can send/compose), and validated by magic bytes. The image
 * lands in the PUBLIC email-assets bucket so it loads in recipients' inboxes.
 */
export async function POST(request: Request) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;

  try {
    enforceDeclaredLength(request, EMAIL_IMAGE_MAX_BYTES + 1024 * 1024, { required: true });
  } catch (error) {
    return apiFailure('api:email/images', error);
  }

  const form = await request.formData();
  const file = form.get('file') as File | null;
  if (!file) return NextResponse.json({ error: 'file required' }, { status: 400 });

  const validationError = await validateEmailImage(file);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const admin = createAdminClient();
  const path = `${randomUUID()}-${storageSafeName(file.name)}`;
  const { error: uploadErr } = await admin.storage.from(BUCKET).upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    cacheControl: '31536000', // content is uuid-addressed, so it can cache indefinitely
  });
  if (uploadErr) return NextResponse.json({ error: uploadErr.message }, { status: 400 });

  const { data } = admin.storage.from(BUCKET).getPublicUrl(path);
  return NextResponse.json({ url: data.publicUrl });
}
