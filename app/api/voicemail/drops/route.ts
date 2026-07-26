import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { randomUUID } from 'crypto';
import {
  storageSafeName,
  validateVoicemailFileContent,
  VOICEMAIL_MAX_BYTES,
} from '@/lib/uploads';
import { enforceDeclaredLength } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';

const BUCKET = 'voicemail-audio';

/** POST multipart { file, name } — uploads a voicemail recording. */
export async function POST(request: Request) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;

  try {
    enforceDeclaredLength(request, VOICEMAIL_MAX_BYTES + 1024 * 1024, { required: true });
  } catch (error) {
    return apiFailure('api:voicemail/drops', error);
  }

  const form = await request.formData();
  const file = form.get('file') as File | null;
  const name = String(form.get('name') ?? '') || file?.name || 'Voicemail';
  if (!file) return NextResponse.json({ error: 'file required' }, { status: 400 });
  const validationError = await validateVoicemailFileContent(file);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const admin = createAdminClient();
  const safeName = storageSafeName(file.name);
  const path = `${randomUUID()}-${safeName}`;

  const { error: uploadErr } = await admin.storage
    .from(BUCKET)
    .upload(path, file, {
      contentType: file.type || 'audio/mpeg',
      cacheControl: '0',
    });
  if (uploadErr) return NextResponse.json({ error: uploadErr.message }, { status: 400 });

  const { data: drop, error } = await admin
    .from('voicemail_drops')
    .insert({ name, audio_path: path, created_by: auth.profile.id })
    .select('*')
    .single();
  if (error) {
    await admin.storage.from(BUCKET).remove([path]);
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ drop });
}
