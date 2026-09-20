/**
 * The SDK's error type and the mappings into it.
 *
 * Every rejection the public API produces is a `MockupError`: a real
 * `Error` subclass (so Sentry and friends aggregate it) carrying a `kind`
 * from the contract's open enum, whether a retry could plausibly help, and
 * an optional `detail` payload.
 *
 * Extracted from index.ts so the pure request/response logic can raise
 * contract errors without importing the client.
 */
import type { MockupErrorKind } from '../types/mocksimple';

/** Kinds a caller can usefully retry without changing anything. */
const RETRYABLE_BY_DEFAULT: ReadonlySet<string> = new Set([
  'network',
  'rate-limited',
  'device-lost',
]);

/** The only error type the SDK throws — a real `Error` subclass. */
export class MockupError extends Error {
  readonly kind: MockupErrorKind;
  readonly retryable: boolean;
  readonly detail?: unknown;

  constructor(
    kind: MockupErrorKind,
    message: string,
    options?: { retryable?: boolean; detail?: unknown; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'MockupError';
    this.kind = kind;
    this.retryable = options?.retryable ?? RETRYABLE_BY_DEFAULT.has(kind);
    this.detail = options?.detail;
  }

  /** Type guard; with a `kind`, narrows to a MockupError OF that kind so an
   * `else` branch keeps the rest of the union (contract signature). */
  static is<K extends MockupErrorKind>(e: unknown, kind: K): e is MockupError & { kind: K };
  static is(e: unknown): e is MockupError;
  static is(e: unknown, kind?: MockupErrorKind): boolean {
    return e instanceof MockupError && (kind === undefined || e.kind === kind);
  }
}

export function badRequest(message: string): MockupError {
  return new MockupError('bad-request', message);
}

export function cancelled(message: string): MockupError {
  return new MockupError('cancelled', message);
}

/**
 * Any AbortError SHAPE, not just a DOMException: the host contract lets a
 * caller construct its own (clause 2), and misreading one as a transport
 * failure would turn a cancellation into a retried network error.
 */
export function isAbortRejection(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

/** Engine rejections/throws are plain `{kind, message, retryable, detail?}`
 * objects (wasm-bindgen classes cannot subclass `Error`); rewrap them. */
function isEngineErrorObject(
  e: unknown,
): e is { kind: string; message: string; retryable?: unknown; detail?: unknown } {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { kind?: unknown }).kind === 'string' &&
    typeof (e as { message?: unknown }).message === 'string' &&
    !(e instanceof Error)
  );
}

export function toMockupError(e: unknown): MockupError {
  if (MockupError.is(e)) return e;
  if (isEngineErrorObject(e)) {
    return new MockupError(e.kind, e.message, {
      retryable: e.retryable === true,
      detail: e.detail,
    });
  }
  if (typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'AbortError') {
    return new MockupError('cancelled', 'operation aborted', { cause: e });
  }
  const message = e instanceof Error ? e.message : String(e);
  return new MockupError('internal', message || 'unknown internal failure', { cause: e });
}
