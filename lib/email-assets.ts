import type { createAdminClient } from '@/lib/supabase/server';

type Admin = ReturnType<typeof createAdminClient>;

export const EMAIL_ASSET_BUCKET = 'email-assets';
export const EMAIL_ASSET_UNREFERENCED_LIMIT_BYTES = 100 * 1024 * 1024;

/** Storage paths from this application's public email-assets URLs only. */
export function emailAssetPaths(html: string): string[] {
  const paths = new Set<string>();
  const re = /\/storage\/v1\/object\/public\/email-assets\/([^?"'<>\s)]+)/gi;
  for (const match of String(html ?? '').matchAll(re)) {
    try {
      const path = decodeURIComponent(match[1]);
      if (path && !path.includes('..') && !path.startsWith('/')) paths.add(path);
    } catch {
      // An invalid URL escape cannot identify one of our stored objects.
    }
  }
  return [...paths];
}

/** Mark uploaded assets as durable before a template/message starts using them. */
export async function markEmailAssetsReferenced(admin: Admin, html: string): Promise<void> {
  const paths = emailAssetPaths(html);
  if (!paths.length) return;
  const { error } = await admin
    .from('email_assets')
    .update({ referenced_at: new Date().toISOString() })
    .in('storage_path', paths)
    .is('referenced_at', null);
  if (error) throw new Error(`Could not retain inline email images: ${error.message}`);
}

/** Total abandoned-upload bytes, used as a hard per-installation quota. */
export async function unreferencedEmailAssetBytes(admin: Admin): Promise<number> {
  const { data, error } = await admin.rpc('email_asset_unreferenced_bytes');
  if (error) throw new Error(`Could not inspect email image quota: ${error.message}`);
  return Number(data ?? 0);
}

/**
 * Remove abandoned uploads after a grace period. Referenced assets are retained
 * indefinitely because old delivered emails still depend on their public URLs.
 */
export async function pruneUnreferencedEmailAssets(
  admin: Admin,
  keepHours = 24,
  limit = 50
): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - Math.max(1, keepHours) * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from('email_assets')
    .select('id, storage_path')
    .is('referenced_at', null)
    .lt('created_at', cutoff)
    .order('created_at')
    .limit(Math.min(Math.max(limit, 1), 100));
  if (error) throw new Error(`Could not list abandoned email images: ${error.message}`);
  if (!data?.length) return { deleted: 0 };

  const paths = data.map((row) => row.storage_path);
  const removed = await admin.storage.from(EMAIL_ASSET_BUCKET).remove(paths);
  if (removed.error) throw new Error(`Could not delete abandoned email images: ${removed.error.message}`);

  const ids = data.map((row) => row.id);
  const deleted = await admin.from('email_assets').delete().in('id', ids);
  if (deleted.error) throw new Error(`Could not clear email image registry: ${deleted.error.message}`);
  return { deleted: ids.length };
}
