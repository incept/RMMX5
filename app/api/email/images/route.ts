import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { requireAdmin } from '@/lib/api-auth';
import { createAdminClient } from '@/lib/supabase/server';
import { EMAIL_IMAGE_MAX_BYTES, storageSafeName, validateEmailImage } from '@/lib/uploads';
import { enforceDeclaredLength, readJsonBody } from '@/lib/request-limits';
import { apiFailure } from '@/lib/api-errors';
import {
  EMAIL_ASSET_BUCKET,
  EMAIL_ASSET_UNREFERENCED_LIMIT_BYTES,
  markEmailAssetsReferenced,
  unreferencedEmailAssetBytes,
} from '@/lib/email-assets';

export const runtime = 'nodejs';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  const unreferencedBytes = await unreferencedEmailAssetBytes(admin);
  if (unreferencedBytes + file.size > EMAIL_ASSET_UNREFERENCED_LIMIT_BYTES) {
    return NextResponse.json(
      { error: 'Email image quota reached. Reuse an existing image or wait for abandoned uploads to be cleaned.' },
      { status: 413 }
    );
  }
  const path = `${randomUUID()}-${storageSafeName(file.name)}`;
  const { error: uploadErr } = await admin.storage.from(EMAIL_ASSET_BUCKET).upload(path, file, {
    contentType: file.type || 'application/octet-stream',
    cacheControl: '31536000', // content is uuid-addressed, so it can cache indefinitely
  });
  if (uploadErr) return NextResponse.json({ error: uploadErr.message }, { status: 400 });

  const { data } = admin.storage.from(EMAIL_ASSET_BUCKET).getPublicUrl(path);
  const registered = await admin
    .from('email_assets')
    .insert({
      storage_path: path,
      public_url: data.publicUrl,
      size_bytes: file.size,
      mime_type: file.type,
      uploaded_by: auth.profile.id,
    })
    .select('id')
    .single();
  if (registered.error || !registered.data) {
    await admin.storage.from(EMAIL_ASSET_BUCKET).remove([path]).catch(() => {});
    return apiFailure(
      'api:email/images',
      registered.error ?? new Error('Email image registry insert returned no row')
    );
  }
  return NextResponse.json({ id: registered.data.id, url: data.publicUrl });
}

/** Retain images when an admin saves inline sequence content. */
export async function PATCH(request: Request) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  try {
    const body = await readJsonBody(request, 1024 * 1024);
    const html = String(body?.html ?? '').slice(0, 750_000);
    await markEmailAssetsReferenced(createAdminClient(), html);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiFailure('api:email/images', error);
  }
}

/** Delete an abandoned asset, or a referenced one only with explicit force. */
export async function DELETE(request: Request) {
  const auth = await requireAdmin();
  if ('error' in auth) return auth.error;
  const params = new URL(request.url).searchParams;
  const id = params.get('id');
  const force = params.get('force') === 'true';
  if (!id || !UUID_PATTERN.test(id)) {
    return NextResponse.json({ error: 'A valid email asset id is required' }, { status: 400 });
  }

  const admin = createAdminClient();
  const asset = await admin
    .from('email_assets')
    .select('id, storage_path, referenced_at')
    .eq('id', id)
    .maybeSingle();
  if (asset.error) return apiFailure('api:email/images', asset.error);
  if (!asset.data) return NextResponse.json({ error: 'Email asset not found' }, { status: 404 });
  if (asset.data.referenced_at && !force) {
    return NextResponse.json(
      { error: 'This image has been used in email. Pass force=true only if breaking old email images is intended.' },
      { status: 409 }
    );
  }

  const removed = await admin.storage.from(EMAIL_ASSET_BUCKET).remove([asset.data.storage_path]);
  if (removed.error) return apiFailure('api:email/images', removed.error);
  const deleted = await admin.from('email_assets').delete().eq('id', id);
  if (deleted.error) return apiFailure('api:email/images', deleted.error);
  return NextResponse.json({ ok: true });
}
