import { MAX_ANALYSIS_BODY_BYTES } from './ai-analysis';
import { awaitWithSignal, createDeadline } from './request-cancellation';

export class AnalysisBodyError extends Error {
  constructor(readonly code: 'invalid_request' | 'request_too_large') { super(code); }
}

/** Cancellation never waits for a potentially stalled underlying stream cancel callback. */
export async function readAnalysisBody(request: Request, signal: AbortSignal, deadlineMs: number): Promise<string> {
  const deadline = createDeadline(signal, deadlineMs, 'body');
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let complete = false;
  try {
    deadline.check();
    reader = request.body?.getReader();
    if (!reader) throw new AnalysisBodyError('invalid_request');
    const length = request.headers.get('content-length');
    if (length && Number(length) > MAX_ANALYSIS_BODY_BYTES) throw new AnalysisBodyError('request_too_large');
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      deadline.check();
      const { done, value } = await awaitWithSignal(deadline.signal, () => reader!.read());
      deadline.check();
      if (done) { complete = true; break; }
      total += value.byteLength;
      if (total > MAX_ANALYSIS_BODY_BYTES) throw new AnalysisBodyError('request_too_large');
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(bytes);
  } finally {
    deadline.dispose();
    if (reader) {
      if (!complete) void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
