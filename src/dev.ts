/**
 * Development mode — `init({ dev: true })`.
 *
 * Third parties get the host contract wrong, and the failure mode is SILENT
 * (DESIGN §4.4). This is the middle line of defence, between the built-in
 * host most integrations use and the conformance suite they run in CI: it
 * catches the mistake in the integrator's own app, at the call that made it.
 *
 * Nothing here runs unless dev mode is on, and the module keeps that state
 * so the hot paths only pay an `isDevMode()` check.
 *
 * A violation is REPORTED via console.error (deduped) and thrown. The log is
 * the authoritative channel: on the engine-driven routes ('model' and
 * 'asset') the throw crosses into Rust, whose transport knows only `Aborted`
 * (never retried) and `Network` (retried), so a violation there runs the
 * full retry schedule and finally surfaces as kind:'network'. Giving it a
 * non-retryable classification needs a HostError variant in mockup-host;
 * until then the console.error is what tells the truth.
 */
import { isAbortRejection, MockupError } from './errors.js';
import type { HostRequest, HostResponse, InitOptions, MockupHost } from '../types/mocksimple';

// ---------------------------------------------------------------------------
// Dev mode — init({dev: true})
// ---------------------------------------------------------------------------
//
// Third parties get the host contract wrong, and the failure mode is
// SILENT (DESIGN §4.4). This is the middle line of defence: it catches the
// mistake in the integrator's own app, at the call that made it. Nothing
// here runs unless dev mode is on.
//
// A violation is REPORTED via console.error (deduped) and thrown. The log
// is the authoritative channel: on the engine-driven routes ('model' and
// 'asset') the throw crosses into Rust, whose transport knows only
// `Aborted` (never retried) and `Network` (retried), so a violation there
// runs the full retry schedule and finally surfaces as kind:'network'.
// Giving it a non-retryable classification needs a HostError variant in
// mockup-host; until then the console.error is what tells the truth.

let devMode = false;

/** Whether `init({dev: true})` has been called. Checked on hot paths. */
export function isDevMode(): boolean {
  return devMode;
}

/** Dev mode is sticky: any init() asking for it turns it on for good. */
export function enableDevMode(): void {
  devMode = true;
}

/** Options the first init() won with; later calls are ignored (dev warns). */
let initOptionsSeen: InitOptions | undefined;

export function devWarn(message: string, detail?: unknown): void {
  if (typeof console === 'undefined') return;
  if (detail !== undefined) console.warn(`[mocksimple dev] ${message}`, detail);
  else console.warn(`[mocksimple dev] ${message}`);
}

const reportedViolations = new Set<string>();

/**
 * A host-contract violation is the integrator's bug: name the clause.
 *
 * Also logged directly, once per distinct violation. The thrown error can be
 * re-labelled by the call site (the image path wraps transport failures) or
 * retried by the Rust transport, so the log is what guarantees the
 * integrator sees these words at all.
 */
function hostViolation(message: string, cause?: unknown): MockupError {
  if (!reportedViolations.has(message)) {
    reportedViolations.add(message);
    if (typeof console !== 'undefined') {
      console.error(`[mocksimple dev] MockupHost contract violation: ${message}`, cause ?? '');
    }
  }
  return new MockupError('bad-request', `MockupHost contract violation: ${message}`, {
    retryable: false,
    detail: { violation: message },
    cause,
  });
}


/** Native fetch throws TypeError on transport failure; the contract also
 * names the `{name:'NetworkError'}` shape. */
function isTransportRejection(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'NetworkError';
}

/** An HTTP status hiding inside a rejection — the shape axios and friends
 * produce, and the exact inverse of contract clause 1. */
function rejectionHttpStatus(e: unknown): number | undefined {
  if (typeof e !== 'object' || e === null) return undefined;
  const o = e as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  for (const candidate of [o.status, o.statusCode, o.response?.status]) {
    if (typeof candidate === 'number' && candidate >= 100 && candidate <= 599) return candidate;
  }
  return undefined;
}

function assertHostResponse(request: HostRequest, res: unknown): void {
  const where = `(${request.role} request for ${request.url})`;
  if (typeof res !== 'object' || res === null) {
    throw hostViolation(`fetch() resolved with ${typeof res}, expected a HostResponse object ${where}`);
  }
  const r = res as { status?: unknown; headers?: unknown; body?: unknown };
  if (
    typeof r.status !== 'number' ||
    !Number.isInteger(r.status) ||
    r.status < 100 ||
    r.status > 599
  ) {
    throw hostViolation(
      `response.status must be an integer HTTP status, got ${JSON.stringify(r.status)} ${where}`,
    );
  }
  if (typeof Headers !== 'undefined' && r.headers instanceof Headers) {
    throw hostViolation(
      `response.headers must be a plain object, got a Headers instance ${where}. ` +
        'Convert it: Object.fromEntries(res.headers).',
    );
  }
  if (typeof r.headers !== 'object' || r.headers === null) {
    throw hostViolation(
      `response.headers must be a plain object of header names, got ${typeof r.headers} ${where}`,
    );
  }
  const view = r.body as (ArrayBufferView & { BYTES_PER_ELEMENT?: number }) | undefined;
  if (!ArrayBuffer.isView(r.body) || view?.BYTES_PER_ELEMENT !== 1) {
    const got =
      r.body instanceof ArrayBuffer
        ? 'an ArrayBuffer (wrap it: new Uint8Array(buf))'
        : typeof r.body === 'string'
          ? 'a string (encode it: new TextEncoder().encode(s))'
          : r.body === undefined || r.body === null
            ? `${String(r.body)} (return an empty Uint8Array for empty bodies)`
            : `${typeof r.body} (parsed JSON? the SDK parses bodies itself)`;
    throw hostViolation(`response.body must be a Uint8Array, got ${got} ${where}`);
  }
}

/**
 * Contract clause 3, the headline integration bug: a host that resolves
 * upstream FAILURES as HTTP 200 envelopes makes the SDK's retry
 * unreachable while the integrator's tests stay green. Detectable on the
 * model route, where the envelope is ours.
 */
function warnOnSwallowedFailure(request: HostRequest, res: HostResponse): void {
  if (request.role !== 'model' || res.status !== 200 || res.body.byteLength > 4096) return;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(res.body));
    const code = (parsed as { code?: unknown } | null)?.code;
    if (typeof code === 'number' && code !== 0) {
      devWarn(
        `host resolved an upstream failure as HTTP 200 for ${request.url} (envelope code ${code}). ` +
          'The SDK retries on HTTP status codes, so a failure delivered as 200 is permanent and ' +
          'invisible to it. Pass the upstream status through instead (contract clause 3).',
      );
    }
  } catch {
    // Not our envelope, or not JSON: the SDK's own parser reports that.
  }
}

/** Wraps an INJECTED host so every call is checked against the contract.
 * The built-in host is not wrapped (it is the reference implementation). */
export function wrapHostForDev(host: MockupHost): MockupHost {
  const wrapped: MockupHost = {
    fetch: async (request) => {
      let res: HostResponse;
      try {
        res = await host.fetch(request);
      } catch (e) {
        if (isAbortRejection(e) || isTransportRejection(e)) throw e;
        const status = rejectionHttpStatus(e);
        if (status !== undefined) {
          throw hostViolation(
            `fetch() REJECTED with HTTP ${status} for ${request.url}; every HTTP result must ` +
              'RESOLVE (clause 1). Axios-style clients reject on 4xx/5xx: catch that and resolve ' +
              '{status, headers, body}, or the SDK cannot tell auth from rate-limiting from a ' +
              'retryable 503.',
            e,
          );
        }
        throw hostViolation(
          `fetch() rejected with neither an AbortError nor a transport failure for ${request.url} ` +
            '(clause 2). Only cancellation and transport failures may reject.',
          e,
        );
      }
      assertHostResponse(request, res);
      warnOnSwallowedFailure(request, res);
      return res;
    },
  };
  if (host.decodeImage) {
    const decode = host.decodeImage.bind(host);
    wrapped.decodeImage = async (bytes, mime) => {
      const bitmap = await decode(bytes, mime);
      if (typeof ImageBitmap !== 'undefined' && !(bitmap instanceof ImageBitmap)) {
        throw hostViolation(
          `decodeImage() must resolve an ImageBitmap, got ${typeof bitmap} (mime ${mime})`,
        );
      }
      return bitmap;
    };
  }
  return wrapped;
}

/** Leak detection state, shared between a Render and the registry. Holds no
 * reference back to the Render, so it cannot keep it alive. */
/** Shared between a Render and the registry; holds no reference back, so it
 * cannot keep the Render alive. */
export interface LeakState {
  disposed: boolean;
  label: string;
}

/** A handle collected without dispose() leaks what it pinned — a Render its
 * ImageBitmap, a Surface or DecalImage its textures (those never go away on
 * their own: the engine keeps them until released). On iOS Safari that kills
 * the tab rather than degrading. */
const leakRegistry =
  typeof FinalizationRegistry !== 'undefined'
    ? new FinalizationRegistry<LeakState>((state) => {
        if (state.disposed) return;
        devWarn(
          `a handle was garbage-collected without dispose() (${state.label}). Call dispose(), ` +
            'use `using`, or — for a Render — hand ownership over with takeImageBitmap().',
        );
      })
    : null;

export function warnOnInitOptionMismatch(options: InitOptions | undefined): void {
  // Nothing to ignore when the caller passed nothing — createClient() calls
  // init() with no options on every client.
  if (options === undefined) return;
  const first = initOptionsSeen;
  const differs: string[] = [];
  if (options.wasm !== first?.wasm) differs.push('wasm');
  // `dev` is deliberately NOT compared: it is sticky, so a later call asking
  // for it is honored rather than ignored.
  if (differs.length > 0) {
    devWarn(
      `init() already ran; these options are ignored: ${differs.join(', ')}. ` +
        'The SDK loads once per page — pass options to the first call.',
    );
  }
}


/**
 * Watch one handle (Render, Surface, DecalImage) for the leak warning, in
 * dev mode only. Returns the state the caller flips on dispose (or on
 * `takeImageBitmap()`, which hands ownership over), or `null` when there is
 * nothing to watch.
 */
export function watchForLeak(handle: object, label: string): LeakState | null {
  if (!devMode || !leakRegistry) return null;
  const state: LeakState = { disposed: false, label };
  leakRegistry.register(handle, state);
  return state;
}

/** Remember the options the first init() won with, for the mismatch warning. */
export function rememberInitOptions(options: InitOptions | undefined): void {
  initOptionsSeen = options;
}
