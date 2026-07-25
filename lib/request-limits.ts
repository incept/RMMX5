export class RequestSizeError extends Error {
  status = 413;

  constructor(message = 'Request body is too large') {
    super(message);
    this.name = 'RequestSizeError';
  }
}

function declaredLength(request: Request): number | null {
  const raw = request.headers.get('content-length');
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function enforceDeclaredLength(
  request: Request,
  maxBytes: number,
  opts?: { required?: boolean }
): void {
  const length = declaredLength(request);
  if (length == null) {
    if (opts?.required) {
      const error = new Error('Content-Length is required');
      (error as Error & { status?: number }).status = 411;
      throw error;
    }
    return;
  }
  if (length > maxBytes) throw new RequestSizeError();
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  enforceDeclaredLength(request, maxBytes);
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RequestSizeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readTextBody(request: Request, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readBoundedBody(request, maxBytes));
}

export async function readJsonBody<T = any>(request: Request, maxBytes: number): Promise<T> {
  const text = await readTextBody(request, maxBytes);
  try {
    return JSON.parse(text) as T;
  } catch {
    const error = new Error('Invalid JSON payload');
    (error as Error & { status?: number }).status = 400;
    throw error;
  }
}

export async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new RequestSizeError('Upstream response is too large');
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RequestSizeError('Upstream response is too large');
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

export function requestErrorResponse(error: unknown): { message: string; status: number } {
  const candidate = error as { message?: string; status?: number };
  return {
    message: candidate?.message ?? 'Invalid request',
    status: candidate?.status ?? 400,
  };
}
