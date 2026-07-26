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
import { logDebug } from '@/lib/debug-log';

type Params = { params: Promise<{ id: string }> };

const BUCKET = 'contact-files';
const MAX_FILES_PER_CONTACT = 50;
const MAX_BYTES_PER_CONTACT = 100 * 1024 * 1024;

/** GET lists the contact's files with fresh signed download URLs (1 hour). */
export async function GET(request: Request, { params }: Params) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const { id } = await params;

  const search = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(Number(search.get('limit')) || 50, 1), 50);
  const offset = Math.max(Number(search.get('offset')) || 0, 0);
  const admin = createAdminClient();
  const { data: files, count, error: listError } = await admin
    .from('contact_files')
    .select('*', { count: 'exact' })
    .eq('contact_id', id)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (listError) return NextResponse.json({ error: listError.message }, { status: 400 });

  const withUrls = await Promise.all(
    (files ?? []).map(async (f) => {
      const { data, error } = await admin.storage
        .from(BUCKET)
        .createSignedUrl(f.storage_path, 3600, { download: f.name });
      return { ...f, url: error ? null : data?.signedUrl ?? null };
    })
  );

  return NextResponse.json({ files: withUrls, total: count ?? 0, limit, offset });
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
  const { data: usage, error: usageError } = await admin
    .rpc('contact_file_usage', { p_contact_id: id })
    .maybeSingle<{ file_count: number; total_bytes: number }>();
  if (usageError) return apiFailure('api:contacts/[id]/files', usageError, { contactId: id });
  if (
    Number(usage?.file_count ?? 0) >= MAX_FILES_PER_CONTACT ||
    Number(usage?.total_bytes ?? 0) + file.size > MAX_BYTES_PER_CONTACT
  ) {
    return NextResponse.json(
      { error: 'Contact file quota reached (50 files or 100 MB)' },
      { status: 413 }
    );
  }

  const safeName = storageSafeName(file.name);
  const originalName = file.name.trim().slice(0, 255) || safeName;
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
      name: originalName,
      storage_path: path,
      size_bytes: file.size,
      mime_type: file.type,
      uploaded_by: auth.profile.id,
    })
    .select('*')
    .single();
  if (error) {
    const { error: cleanupError } = await admin.storage.from(BUCKET).remove([path]);
    if (cleanupError) {
      await logDebug({
        source: 'files:orphan-upload',
        message: `Could not remove object after metadata insert failed: ${cleanupError.message}`,
        context: { path, insert_error: error.message },
        contactId: id,
      });
    }
    return apiFailure('api:contacts/[id]/files', error, { contactId: id });
  }

  await logActivity({
    contactId: id,
    actorId: auth.profile.id,
    type: 'file',
    description: `File uploaded: ${originalName}`,
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

  const { data: marked, error: markError } = await admin
    .from('contact_files')
    .update({ status: 'deleting' })
    .eq('id', fileId)
    .eq('status', 'active')
    .select('id')
    .maybeSingle();
  if (markError) return apiFailure('api:contacts/[id]/files', markError, { contactId: id });
  if (!marked) return NextResponse.json({ error: 'File is already being deleted' }, { status: 409 });

  const { error: storageError } = await admin.storage.from(BUCKET).remove([file.storage_path]);
  if (storageError) {
    await admin.from('contact_files').update({ status: 'active' }).eq('id', fileId);
    return apiFailure('api:contacts/[id]/files', storageError, { contactId: id });
  }
  const { error: deleteError } = await admin.from('contact_files').delete().eq('id', fileId);
  if (deleteError) {
    await logDebug({
      source: 'files:metadata-delete',
      message: `Storage object was removed but metadata cleanup failed: ${deleteError.message}`,
      context: { file_id: fileId, storage_path: file.storage_path },
      contactId: id,
    });
    return apiFailure('api:contacts/[id]/files', deleteError, { contactId: id });
  }

  await logActivity({
    contactId: id,
    actorId: auth.profile.id,
    type: 'file',
    description: `File deleted: ${file.name}`,
  });

  return NextResponse.json({ ok: true });
}
