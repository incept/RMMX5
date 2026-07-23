import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';

const BUCKET = 'voicemail-audio';

/** POST multipart { file, name } — uploads a voicemail recording. */
export async function POST(request: Request) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;

  const form = await request.formData();
  const file = form.get('file') as File | null;
  const name = String(form.get('name') ?? '') || file?.name || 'Voicemail';
  if (!file) return NextResponse.json({ error: 'file required' }, { status: 400 });

  const admin = createAdminClient();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${Date.now()}-${safeName}`;

  const { error: uploadErr } = await admin.storage
    .from(BUCKET)
    .upload(path, Buffer.from(await file.arrayBuffer()), {
      contentType: file.type || 'audio/mpeg',
    });
  if (uploadErr) return NextResponse.json({ error: uploadErr.message }, { status: 400 });

  const { data: drop, error } = await admin
    .from('voicemail_drops')
    .insert({ name, audio_path: path, created_by: auth.profile.id })
    .select('*')
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ drop });
}
