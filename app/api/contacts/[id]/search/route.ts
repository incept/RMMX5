import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-auth';
import { runAutoSearchForContact } from '@/lib/lead-intake';

type Params = { params: Promise<{ id: string }> };

/** POST runs the automatic Google search (BrightData) for one contact on demand. */
export async function POST(_request: Request, { params }: Params) {
  const auth = await requireUser();
  if ('error' in auth) return auth.error;
  const { id } = await params;

  try {
    const result = await runAutoSearchForContact(id, auth.profile.id);
    return NextResponse.json(result);
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
}
