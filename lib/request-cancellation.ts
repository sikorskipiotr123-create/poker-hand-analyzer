/** Fixed server deadlines; request headers and payloads cannot override them.
 * The 60-second budget leaves five seconds below the platform route limit. It starts
 * at handler entry: ingress/middleware buffering must be bounded by the hosting layer.
 */
export const ANALYZE_REQUEST_DEADLINE_MS = 60_000;
export const ANALYZE_BODY_DEADLINE_MS = 10_000;
export const ANALYZE_PROVIDER_DEADLINE_MS = 60_000;
export type CancellationSource = 'client' | 'request' | 'body' | 'provider' | 'redis';
export class OperationCancelledError extends Error {
  constructor(readonly source: CancellationSource) {
    super(source === 'client' ? 'Request cancelled.' : 'Operation deadline exceeded.');
    this.name = source === 'client' ? 'AbortError' : 'TimeoutError';
  }
}
export function cancellationReason(signal: AbortSignal): OperationCancelledError {
  return signal.reason instanceof OperationCancelledError ? signal.reason : new OperationCancelledError('client');
}
export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellationReason(signal);
}

/** Combines an optional parent with a deadline, preserving the first cancellation reason.
 * Explicit disposal removes the parent listener and clears the timer on every response path.
 */
export function createDeadline(parent: AbortSignal | undefined, milliseconds: number, source: Exclude<CancellationSource, 'client'>) {
  const controller = new AbortController();
  const expiresAt = performance.now() + milliseconds;
  const onParentAbort = () => controller.abort(cancellationReason(parent!));
  parent?.addEventListener('abort', onParentAbort, { once: true });
  if (parent?.aborted) onParentAbort();
  const timer = setTimeout(() => controller.abort(new OperationCancelledError(source)), milliseconds);
  return {
    signal: controller.signal,
    check: () => {
      // Timer callbacks cannot run during synchronous JS; check elapsed time at stage boundaries too.
      if (!controller.signal.aborted && performance.now() >= expiresAt) controller.abort(new OperationCancelledError(source));
      throwIfCancelled(controller.signal);
    },
    dispose: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

/** Bound the wait even when an adapter ignores AbortSignal. The operation must also receive
 * the signal to stop its underlying I/O. Late rejection/resolution is always observed.
 */
export async function awaitWithSignal<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  throwIfCancelled(signal);
  let onAbort: () => void = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => reject(cancellationReason(signal));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) { onAbort(); return; }
      try { operation().then(resolve, reject); } catch (error) { reject(error); }
    });
  } finally { signal.removeEventListener('abort', onAbort); }
}
