import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { logActivity } from '@/lib/activity';
import { randomUUID } from 'crypto';
import {
  CONTACT_FILE_MAX_BYTES,
  storageSafeName,
  validateContactFileContent,
} from '@/lib/uploads';
import { enforceDeclaredLength } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';

type Params = { params: Promise<{ id: string }> };

const BUCKET = 'contact-files';

/** GET lists the contact's files with fresh signed download URLs (1 hour). */
export async function GET(_request: Request, { params }: Params) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const { id } = await params;

  const admin = createAdminClient();
  const { data: files, error: listError } = await admin
    .from('contact_files')
    .select('*')
    .eq('contact_id', id)
    .order('created_at', { ascending: false });
  if (listError) return NextResponse.json({ error: listError.message }, { status: 400 });

  const withUrls = await Promise.all(
    (files ?? []).map(async (f) => {
      const { data, error } = await admin.storage
        .from(BUCKET)
        .createSignedUrl(f.storage_path, 3600, { download: f.name });
      return { ...f, url: error ? null : data?.signedUrl ?? null };
    })
  );

  return NextResponse.json({ files: withUrls });
}

/** POST multipart form-data { file } — uploads into the private bucket. */
export async function POST(request: Request, { params }: Params) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const { id } = await params;

  const admin = createAdminClient();
  const { data: contact } = await admin.from('contacts').select('id').eq('id', id).maybeSingle();
  if (!contact) return NextResponse.json({ error: 'Contact not found' }, { status: 404 });

  try {
    enforceDeclaredLength(request, CONTACT_FILE_MAX_BYTES + 1024 * 1024, { required: true });
  } catch (error) {
    return apiFailure('api:contacts/[id]/files', error);
  }

  const form = await request.formData();
  const file = form.get('file') as File | null;
  if (!file) return NextResponse.json({ error: 'file required' }, { status: 400 });
  const validationError = await validateContactFileContent(file);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const safeName = storageSafeName(file.name);
  const path = `${id}/${randomUUID()}-${safeName}`;

  const { error: uploadErr } = await admin.storage
    .from(BUCKET)
    .upload(path, file, {
      contentType: file.type || 'application/octet-stream',
      cacheControl: '0',
    });
  if (uploadErr) return NextResponse.json({ error: uploadErr.message }, { status: 400 });

  const { data: row, error } = await admin
    .from('contact_files')
    .insert({
      contact_id: id,
      name: file.name,
      storage_path: path,
      size_bytes: file.size,
      mime_type: file.type,
      uploaded_by: auth.profile.id,
    })
    .select('*')
    .single();
  if (error) {
    await admin.storage.from(BUCKET).remove([path]);
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  await logActivity({
    contactId: id,
    actorId: auth.profile.id,
    type: 'file',
    description: `File uploaded: ${file.name}`,
  });

  return NextResponse.json({ file: row });
}

/** DELETE ?fileId= removes the file from storage and the table. */
export async function DELETE(request: Request, { params }: Params) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const { id } = await params;
  const fileId = new URL(request.url).searchParams.get('fileId');
  if (!fileId) return NextResponse.json({ error: 'fileId required' }, { status: 400 });

  const admin = createAdminClient();
  const { data: file } = await admin
    .from('contact_files')
    .select('*')
    .eq('id', fileId)
    .eq('contact_id', id)
    .single();
  if (!file) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { error: storageError } = await admin.storage.from(BUCKET).remove([file.storage_path]);
  if (storageError) {
    return NextResponse.json({ error: storageError.message }, { status: 400 });
  }
  const { error: deleteError } = await admin.from('contact_files').delete().eq('id', fileId);
  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 400 });
  }

  await logActivity({
    contactId: id,
    actorId: auth.profile.id,
    type: 'file',
    description: `File deleted: ${file.name}`,
  });

  return NextResponse.json({ ok: true });
}
