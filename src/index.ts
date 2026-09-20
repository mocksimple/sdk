/**
 * mocksimple — the public surface.
 *
 * This file is the whole API: `init`, `createClient`, and the re-exports the
 * contract declares. api/mocksimple.d.ts is the source of truth, copied
 * verbatim to ../types/mocksimple.d.ts, and package.json points
 * `exports.types` at that copy — so the published package contains exactly
 * one .d.ts and it is the one we authored, not one tsc inferred.
 * test/contract-check.ts pins this implementation against it.
 *
 * The package ships BUILT JavaScript (tsconfig.build.json emits src/*.ts to
 * dist/*.js). Shipping the .ts source instead would push our own compiler
 * settings onto every consumer: `.ts` import specifiers need
 * allowImportingTsExtensions, and `[Symbol.dispose]` needs
 * lib ESNext.Disposable. test/consumer/ pins that a plain tsconfig compiles
 * against us.
 *
 * The implementation lives in modules beside this one:
 *
 *   errors.ts         MockupError and the mappings into it
 *   environment.ts    capability probe, the one hidden WebGL2 context and its
 *                     loss/recovery, device limits
 *   host.ts           createDefaultHost — fetch with the contract's semantics
 *   images.ts         picture sources: fetch, retain, decode
 *   handles.ts        Surface / DecalImage handles and the shared-surface record
 *   render-plan.ts    the pure arithmetic of a render (unit-tested in test/)
 *   render-result.ts  one Render, with take semantics
 *   dev.ts            init({dev:true}) — host-contract checking, leak warnings
 *   client.ts         MockupClient: handles, residency, render orchestration
 *
 * NOT YET IN 0.1.x (each is marked "Not yet in 0.1.x" in the contract, so
 * consumers can grep for the phrase):
 *   - HostRequest.signal never fires (the SDK does not abort its own requests)
 *   - RenderTimings.solveMs is 0 (the solve is inside drawMs)
 *   - {type:'prepare'} carries no totalBytes
 *   - createDefaultHost beyond a plain-fetch passthrough (no Cache API
 *     cacheHint persistence)
 *   - mocksimple/testing (verifyMockupHost)
 */
import wasmInit, { __abiVersion, version as wasmVersion } from '../pkg/mockup.js';
import { MockupClientImpl } from './client.js';
import { enableDevMode, isDevMode, rememberInitOptions, warnOnInitOptionMismatch } from './dev.js';
import { getGpu, probeSupport } from './environment.js';
import { badRequest, MockupError } from './errors.js';
import type { InitOptions, MockupClient, MockupConfig } from '../types/mocksimple';

// Every declared type is re-exported so consumers can `import type` from the
// package; the runtime values are implemented here or re-exported above.
export { MockupError } from './errors.js';
export { isSupported } from './environment.js';
export { createDefaultHost } from './host.js';
export type {
  AbortOptions,
  DecalBound,
  DecalImage,
  DecalSpec,
  EncodeOptions,
  HeaderMap,
  HostRequest,
  HostResponse,
  ImageSource,
  InitOptions,
  KnownMockupErrorKind,
  MockupClient,
  MockupConfig,
  MockupConfigOptions,
  MockupConfigWithHost,
  MockupConfigWithKey,
  MockupErrorKind,
  MockupEvent,
  MockupHost,
  MockupLimits,
  MockupStats,
  Point,
  ProbeReason,
  ProbeResult,
  Render,
  RenderRequest,
  RenderTimings,
  RequestRole,
  Size,
  Surface,
} from '../types/mocksimple';

// Runtime fallback for environments without native explicit resource
// management (the typed Symbol.dispose comes from lib ESNext.Disposable).
(Symbol as { dispose?: symbol }).dispose ??= Symbol.for('Symbol.dispose');

// ---------------------------------------------------------------------------
// Module-level constants
// ---------------------------------------------------------------------------

/** Same value as the npm package version (js/package.json) and the wasm's
 * `version()` — scripts/check-version.mjs keeps the literals aligned, and
 * init() refuses a shim/wasm mismatch at runtime. */
export const VERSION = '0.2.2';

/** ABI stamp this shim was built against (checked at init()). v2: resident
 * images by key, canvas output, resetGpu, prepare progress. v3: half-size
 * image variants (uploadImageLow) for the color-correction pass. */
const ABI_VERSION = 4;

/**
 * Built-in production endpoints, so `createClient({ apiKey })` is a complete
 * integration and a third party never has to know the service topology
 * (API.md §5). `MockupConfig.endpoints` overrides them for private and
 * staging deployments.
 *
 * Not secrets — both are plainly visible in the Network panel — but changing
 * either is release-visible for every consumer, so they live here as named
 * constants rather than inline.
 *
 * There is no default asset base. A Surface names each of its maps by
 * absolute URL, so the service already says where they live and the SDK has
 * nothing to assemble — `endpoints.asset` exists only for an integrator who
 * wants those blobs served from somewhere else. An empty base is what tells
 * the engine to use the URLs as given.
 */
const DEFAULT_MODEL_ENDPOINT = 'https://mocksimple.com/v1/surfaces';


// ---------------------------------------------------------------------------
// init()
// ---------------------------------------------------------------------------

let initPromise: Promise<void> | null = null;

/**
 * Vite's dev server pre-bundles dependencies into node_modules/.vite/deps/,
 * and the glue locates the binary with `new URL('mockup_bg.wasm',
 * import.meta.url)` — which, once the glue has been rewritten into that
 * directory, points beside a copy that was never made. Vite's SPA fallback
 * then answers the request with index.html at status 200, and the engine
 * fails to compile a web page. Vite 8's rolldown optimizer rewrites the
 * relative path itself (vitejs/vite@ca96cbc); the esbuild optimizer in
 * 5, 6 and 7 never did (vitejs/vite#8427), and those are most installs.
 *
 * The relocation has a signature: this module's own URL sits under
 * `/node_modules/.vite/`. That is not a guess about where the binary might
 * be — it is a precise reading of what happened to this file, and the
 * original is always at `<same prefix>/node_modules/mocksimple/pkg/`,
 * which Vite serves in dev whether node_modules is flat (npm) or symlinked
 * (pnpm); both were checked. The candidate is fetched and its content type
 * read before it is trusted, so a layout this does not understand falls
 * back to the default path and the precise error, never to a silent wrong
 * binary. A good Response is handed to the glue as-is, which keeps
 * streaming compilation.
 *
 * Returns undefined — "use the default" — everywhere else, which is every
 * build tool, every production bundle, and Vite 8.
 */
async function relocatedWasm(): Promise<{ module_or_path: Response } | undefined> {
  let here: URL;
  try {
    here = new URL(import.meta.url);
  } catch {
    return undefined;
  }
  const m = /^(.*)\/node_modules\/\.vite\//.exec(here.pathname);
  if (!m) return undefined;
  const candidate = new URL(`${m[1]}/node_modules/mocksimple/pkg/mockup_bg.wasm`, here.origin);
  try {
    const res = await fetch(candidate);
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || /text\/html/i.test(type)) return undefined;
    return { module_or_path: res };
  } catch {
    return undefined;
  }
}

/** Loads and instantiates the wasm once per page. Idempotent; concurrent
 * calls coalesce; a failed load resets so a later call can retry. */
export function init(options?: InitOptions): Promise<void> {
  // Dev mode is sticky: any call asking for it turns it on.
  if (options?.dev === true) enableDevMode();
  if (initPromise) {
    if (isDevMode()) warnOnInitOptionMismatch(options);
    return initPromise;
  }
  rememberInitOptions(options);
  const pending: Promise<void> = (async () => {
    const support = probeSupport();
    if (!support.supported) {
      throw new MockupError('unsupported', `missing capability: ${support.missing}`, {
        detail: { capability: support.missing },
      });
    }
    try {
      await wasmInit(
        options?.wasm !== undefined
          ? { module_or_path: options.wasm as Exclude<InitOptions['wasm'], undefined> }
          : await relocatedWasm(),
      );
    } catch (e) {
      if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.CompileError) {
        // A CompileError says the bytes were not valid WebAssembly. Two very
        // different causes produce it, and this used to name only one of
        // them: CSP without 'wasm-unsafe-eval', or — far more likely — the
        // .wasm URL answered with something that is not wasm at all.
        //
        // Vite's dev server does exactly that. It pre-bundles dependencies
        // into node_modules/.vite/deps/, the engine locates its binary with
        // `new URL('mockup_bg.wasm', import.meta.url)`, and the binary was
        // never copied there — so the SPA fallback returns index.html with
        // status 200 and the shim tries to compile a web page. Reported as a
        // CSP problem, that sends the reader to configure headers that were
        // never the issue.
        //
        // The browser's own message names the bytes it found ("expected magic
        // word 00 61 73 6d, found 3c 21 64 6f" — `3c 21` being `<!`), which
        // separates the two cases at a glance, so it is carried through
        // instead of being swallowed.
        throw new MockupError(
          'unsupported',
          'wasm did not compile. Either the .wasm URL served something that is not WebAssembly ' +
            "(a dev server or bundler answering with a page — with Vite, add optimizeDeps: " +
            "{ exclude: ['mocksimple'] }), or CSP is missing 'wasm-unsafe-eval'. " +
            `Underlying error: ${e instanceof Error ? e.message : String(e)}`,
          { detail: { capability: 'csp' }, cause: e },
        );
      }
      throw new MockupError('network', 'failed to load the wasm binary', {
        retryable: true,
        cause: e,
      });
    }
    const abi = __abiVersion();
    if (abi !== ABI_VERSION) {
      throw new MockupError(
        'internal',
        `ABI mismatch: shim expects ${ABI_VERSION}, wasm reports ${abi} (a CDN may have cached an old binary)`,
        { detail: { expected: ABI_VERSION, got: abi } },
      );
    }
    // Same ABI, different release: the two halves of one npm version were
    // deployed apart (a stale .wasm behind a fresh .js, or the reverse).
    const engineVersion = wasmVersion();
    if (engineVersion !== VERSION) {
      throw new MockupError(
        'internal',
        `version mismatch: shim ${VERSION}, wasm ${engineVersion} (mixed deployment — serve both files from the same package version)`,
        { detail: { expected: VERSION, got: engineVersion } },
      );
    }
  })();
  initPromise = pending;
  pending.catch(() => {
    if (initPromise === pending) initPromise = null;
  });
  return pending;
}

// ---------------------------------------------------------------------------
// createClient()
// ---------------------------------------------------------------------------

export async function createClient(config: MockupConfig): Promise<MockupClient> {
  if (typeof config !== 'object' || config === null) {
    throw badRequest('createClient(config) requires a config object');
  }
  // Authentication must come from somewhere: our key, or a host that has
  // its own. A key that is present but blank is a typo either way.
  if (config.apiKey !== undefined) {
    if (typeof config.apiKey !== 'string' || config.apiKey.trim().length === 0) {
      throw badRequest('apiKey must be a non-empty string');
    }
  } else if (config.host === undefined) {
    throw badRequest(
      'pass an apiKey, or a host that owns authentication — checked locally before any network call',
    );
  }
  // Absent endpoints take the built-in production defaults. Present but
  // malformed is a typo rather than a request for the default, so it still
  // fails loudly instead of silently talking to the wrong service.
  const overrides = config.endpoints;
  if (overrides !== undefined && (typeof overrides !== 'object' || overrides === null)) {
    throw badRequest('endpoints must be an object {model?, asset?}');
  }
  let model = DEFAULT_MODEL_ENDPOINT;
  if (overrides?.model !== undefined) {
    if (typeof overrides.model !== 'string' || overrides.model.length === 0) {
      throw badRequest('endpoints.model must be a non-empty URL');
    }
    model = overrides.model;
  }
  // Empty = follow the surface's own map URLs (the normal case).
  let asset: string | ((surfaceUrl: string) => string) = '';
  if (overrides?.asset !== undefined) {
    if (typeof overrides.asset === 'function') {
      asset = overrides.asset;
    } else if (typeof overrides.asset === 'string' && overrides.asset.length > 0) {
      asset = overrides.asset;
    } else {
      throw badRequest(
        'endpoints.asset must be a non-empty base URL or a (surfaceUrl) => string function',
      );
    }
  }
  const support = probeSupport();
  if (!support.supported) {
    throw new MockupError('unsupported', `missing capability: ${support.missing}`, {
      detail: { capability: support.missing },
    });
  }
  await init();
  getGpu(); // throws kind:'unsupported' when WebGL2 cannot be created
  return new MockupClientImpl(config, { model, asset });
}
