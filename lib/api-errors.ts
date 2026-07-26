import { NextResponse } from 'next/server';
import { logDebug, errorMessage } from '@/lib/debug-log';
import { requestErrorResponse } from '@/lib/request-limits';
import { randomUUID } from 'crypto';

/**
 * One place for an API route to fail.
 *
 * Routes were catching errors and returning a message without recording
 * anything, so a genuine fault left no trace at all: the operator saw a status
 * code, and the cause existed only in a host log they cannot reach from the CRM.
 * Deep search was dead for a day behind exactly that gap.
 *
 * What gets logged, and what does not, is the point. requestErrorResponse
 * defaults anything without an explicit status to 400, so a validation failure
 * and an unhandled database error are indistinguishable in the response. They
 * are not indistinguishable here: an error that carries no status of its own was
 * never anticipated by the code that threw it, and those are precisely the ones
 * that have been vanishing. Deliberate 4xx — thrown with a status attached —
 * stay out of the log, because a rejected form submission is not a fault and
 * would bury the ones that are.
 *
 * The response is byte-identical to what these routes returned before, so
 * adopting this changes visibility and nothing else.
 */
export async function apiFailure(
  source: string,
  error: unknown,
  opts?: { contactId?: string | null; context?: Record<string, any> }
): Promise<NextResponse> {
  const response = requestErrorResponse(error);
  const deliberate = typeof (error as { status?: number } | null)?.status === 'number';
  const reference = response.status >= 500 ? randomUUID() : null;

  if (!deliberate || response.status >= 500) {
    await logDebug({
      level: 'error',
      source,
      message: errorMessage(error),
      contactId: opts?.contactId ?? null,
      context: {
        ...opts?.context,
        reference,
        status: response.status,
        // A Postgres error carries these and they are usually the whole answer.
        code: (error as { code?: string } | null)?.code ?? null,
        details: (error as { details?: string } | null)?.details ?? null,
        hint: (error as { hint?: string } | null)?.hint ?? null,
      },
    });
  }

  return NextResponse.json(
    { error: response.message, ...(reference ? { reference } : {}) },
    { status: response.status }
  );
}
