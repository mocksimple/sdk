/**
 * mocksimple — Public API
 *
 * A WASM SDK that turns a photo into a 3D "mockup" surface and composites
 * decal images onto it with perspective-correct distortion, shading and
 * foreground occlusion.
 *
 * Design invariants (see DESIGN.md):
 * - No graphics or wasm HANDLES/types leak through this API. Operational
 *   vocabulary (a WebGL2 support gate, wasm loading options) appears only
 *   in documentation, never as objects the caller can touch.
 * - Resources are explicit, caller-owned handles: a `Surface` (one prepared
 *   photo), a `DecalImage` (one decoded picture) and a `Render` (one
 *   result). Each holds GPU and CPU memory from creation until `dispose()`
 *   — the SDK never evicts behind your back. `MockupClient` is the
 *   configuration scope that creates them and releases whatever is left
 *   when it is disposed itself.
 * - All HTTP goes through an injectable `MockupHost`; a spec-compliant
 *   default host ships with the SDK and is exported for composition.
 * - Enum openness: `MockupErrorKind`, `ProbeReason`, `MockupEvent['type']`
 *   and prepare `stage` are OPEN — new values may appear in minor releases;
 *   treat unknown values as you would 'internal' / ignore unknown events.
 *   `RequestRole` is CLOSED — hosts key auth on it, so adding a role is a
 *   major release.
 *
 * Disposal: every handle carries `[Symbol.dispose]`, so `using` works on
 * TypeScript >= 5.2 (`using surface = await client.prepareSurface(url)`).
 * Where `using` is unavailable, call `dispose()` yourself; an undisposed
 * handle simply stays resident. The symbol's TYPE normally comes from
 * lib ESNext.Disposable; rather than require that of your tsconfig, this
 * file declares it below. At runtime, disposal works everywhere.
 *
 * 0.1.x status: the few places where this release does not yet honour the
 * contract carry a note beginning "Not yet in 0.1.x" (grep for the phrase).
 */

/**
 * `Symbol.dispose` is typed by lib.esnext.disposable. Declaring it here
 * means a consumer on `lib: ["ES2022", "DOM"]` — an ordinary setting — can
 * compile against this contract without adding anything for our sake. The
 * declaration is identical to the lib's, so it MERGES rather than conflicts
 * when a consumer does have ESNext.Disposable. (sdk/consumer-check compiles
 * both ways, with skipLibCheck off, to keep that true.)
 */
declare global {
  interface SymbolConstructor {
    readonly dispose: unique symbol;
  }
  /**
   * `using render = await client.render(...)` needs this global type as well
   * as the symbol — without it TypeScript reports "Cannot find global type
   * 'Disposable'" at the `using`, not at our types. Declared identically to
   * the lib's, so it merges. No `AsyncDisposable`: nothing here implements
   * `[Symbol.asyncDispose]`, so `await using` is genuinely not supported and
   * should keep failing.
   */
  interface Disposable {
    [Symbol.dispose](): void;
  }
}

// ---------------------------------------------------------------------------
// Module-level
// ---------------------------------------------------------------------------

/** SDK version (same value as the npm package version). */
export const VERSION: string;

/**
 * Cheap synchronous capability gate: WebAssembly, WebGL2 and OffscreenCanvas.
 * Computed once and cached. Use it to hide mockup UI before paying any
 * `init()`/`createClient()` cost. `true` is necessary, not sufficient —
 * runtime failures (context loss, OOM) surface later as typed errors.
 */
export function isSupported(): boolean;

export interface InitOptions {
  /**
   * Where to load the .wasm binary from.
   * Default: resolved next to the JS module via
   * `new URL(..., import.meta.url)` (works under Vite / webpack 5 /
   * rsbuild). Pass an explicit value for Next.js App Router, Turbopack, or
   * CDN (`<script type="module">`) setups.
   *
   * Per-type behavior:
   * - `string | URL`: fetched and instantiated.
   * - `Response`: consumed immediately via streaming compilation.
   * - `WebAssembly.Module`: instantiated as is.
   * - `BufferSource`: the bytes, already in hand. This is the escape hatch
   *   for bundlers that will not rewrite `new URL(..., import.meta.url)`
   *   into an asset — inline the binary on YOUR side (Vite `?inline`,
   *   webpack `asset/inline`, or your own base64) and hand us the result.
   *
   * We do not inline by default, and you should reach for it only if your
   * bundler forces you to: base64 costs more over the wire, not less. The
   * expansion survives compression, because the binary is already
   * high-entropy and base64 destroys its byte alignment — measured on this
   * engine, brotli 205 KB -> 288 KB (+40%), gzip 257 KB -> 361 KB (+40%).
   * You also lose `WebAssembly.instantiateStreaming` (compilation can no
   * longer overlap the download), and the binary joins your JS cache entry,
   * so every JS change re-downloads all of it instead of hitting the
   * long-lived .wasm cache.
   */
  wasm?: string | URL | Response | BufferSource | WebAssembly.Module;
  /**
   * Development mode: validates every `MockupHost` call against the host
   * contract and throws actionable errors on violations; warns on leaked
   * (garbage-collected but undisposed) handles; warns when a later
   * `init()` passes different options. Zero overhead when off.
   */
  dev?: boolean;
}

/**
 * Loads and instantiates the SDK once per page. Idempotent; concurrent
 * calls coalesce; options passed to any call after the first are ignored
 * (dev mode warns when they differ). Optional — `createClient()` calls it
 * with defaults — but calling it early hides wasm load latency and
 * surfaces CSP problems (`wasm-unsafe-eval` required) at a predictable
 * time.
 *
 * Everything runs on the calling (main) thread.
 *
 * @throws MockupError kind:'unsupported' (no WebAssembly / WebGL2 /
 *         OffscreenCanvas, or CSP blocked; `detail.capability` says which:
 *         'webassembly' | 'webgl2' | 'offscreen-canvas' | 'csp'),
 *         kind:'network' (wasm fetch failed), kind:'internal' (ABI mismatch
 *         between shim and wasm — e.g. a CDN cached an old binary).
 */
export function init(options?: InitOptions): Promise<void>;

/**
 * Creates a client. A `MockupClient` is a configuration scope that prepares
 * MANY surfaces and renders them — it is not one mockup.
 *
 * Authentication is the only thing you must bring: an `apiKey` for the
 * built-in transport, or a `host` that authenticates its own way. The
 * production service endpoints are built into the SDK, so a minimal
 * integration is `createClient({ apiKey })`.
 *
 * All clients on a page share one internal rendering context, so creating
 * several (one per widget/route) is safe and does not exhaust browser
 * graphics resources. Handles are bound to the client that created them.
 *
 * @throws MockupError kind:'bad-request' (neither `apiKey` nor `host`, or a
 *         malformed one — checked locally before any network call),
 *         kind:'unsupported' when the environment cannot render (no WebGL2
 *         — e.g. hardware acceleration disabled; `detail.capability:
 *         'webassembly' | 'webgl2' | 'offscreen-canvas' | 'csp'` tells you
 *         which remediation to suggest), plus anything `init()` throws. An
 *         invalid or revoked key surfaces later as kind:'auth' on the first
 *         request that uses it.
 */
export function createClient(config: MockupConfig): Promise<MockupClient>;

/**
 * The built-in transport, exported for composition — decorate it instead
 * of re-implementing the host contract:
 *
 * ```ts
 * const base = createDefaultHost({ headers });
 * const host: MockupHost = {
 *   fetch: (req) => base.fetch(
 *     req.role === 'image' ? { ...req, url: proxy(req.url) } : req),
 * };
 * ```
 */
export function createDefaultHost(options?: {
  headers?: MockupConfig['headers'];
}): MockupHost;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Client configuration. Bring EITHER an `apiKey`, which the built-in
 * transport authenticates with, OR your own `host`, which owns auth
 * entirely. The type requires at least one, so a config that could never
 * authenticate does not compile.
 *
 * Both together is normal too: a host that decorates the built-in one (a
 * proxy, an offline cache) still wants the key attached to our requests.
 */
export type MockupConfig = MockupConfigWithKey | MockupConfigWithHost;

/** The common case: the built-in transport, authenticated with your key. */
export interface MockupConfigWithKey extends MockupConfigOptions {
  /**
   * Your API key, issued by the service. Identifies the integration for
   * authentication, quota and usage-based billing.
   *
   * The SDK attaches it to 'model' requests ONLY. Not to 'asset': those go
   * to a public immutable bucket that neither reads nor needs it, and a
   * custom header would turn each cross-origin GET into a preflighted one,
   * paying an extra round trip per asset for nothing. Not to 'image'
   * either: those go to caller-chosen origins, so the key cannot leak to
   * third-party hosts.
   *
   * If a private deployment needs auth on 'asset' too, add it yourself —
   * `headers` is a per-role callback, and a custom `host` sees the role.
   *
   * It is an identification credential designed to appear in frontend
   * code, not a secret: abuse protection happens server-side by binding
   * the key to your registered origins and quota. If you prefer to keep
   * even that off the page, proxy through your own backend with a custom
   * `host` — then the key belongs on your backend and this field can go.
   */
  apiKey: string;

  /** See `MockupConfigOptions` — optional here. */
  host?: MockupHost;
}

/**
 * Your own transport, which owns authentication — so the SDK needs no key
 * of its own. This is the shape for a backend proxy (the key stays on your
 * server), a cookie session, or an offline/preset source that talks to no
 * service at all.
 */
export interface MockupConfigWithHost extends MockupConfigOptions {
  /**
   * Optional here. Provide it only if your host forwards to our service and
   * wants the SDK to attach `x-api-key`; omit it and no key header is sent.
   */
  apiKey?: string;

  host: MockupHost;
}

/** Options shared by both configuration shapes. */
export interface MockupConfigOptions {
  /**
   * ADVANCED — service endpoint overrides for private/staging deployments.
   * Omit entirely in normal use: the production endpoint is built into the
   * SDK and may be updated across SDK releases without any consumer change.
   * Currently `https://mocksimple.com/v1/surfaces` (stated for
   * transparency, not as a contract — do not hardcode it).
   *
   * A key that is present but empty is a typo, and rejects with
   * kind:'bad-request' rather than falling back.
   *
   * - `model`: URL of the surface-generation endpoint.
   * - `asset`: where to fetch a surface's maps from. There is NO default,
   *   and normally no reason to set one: a surface names each of its maps
   *   by absolute URL, so the service already says where they live. Set
   *   this only to serve the same content-addressed blobs from somewhere
   *   else — your own mirror, a staging bucket, an air-gapped deployment —
   *   in which case the SDK appends each map's blob id to the base you
   *   give. Pass a function when that origin depends on the surface.
   *   Caching is unaffected: blobs are keyed by id, not by URL, so moving
   *   them between origins does not invalidate anything already fetched.
   */
  endpoints?: {
    model?: string;
    asset?: string | ((surfaceUrl: string) => string);
  };

  /**
   * Extra request headers — the auth hook for the default host. Either a
   * static map or a (possibly async) per-role callback; called once per
   * network attempt, including SDK-initiated retries (safe place for token
   * refresh — make it single-flight). Ignored when `host` is provided
   * (dev mode warns); put auth inside your host instead.
   */
  headers?: HeaderMap | ((role: RequestRole) => HeaderMap | Promise<HeaderMap>);

  /**
   * Transport override, declared by both configuration shapes. Omit to use
   * the built-in host (recommended). Provide one for custom auth flows,
   * proxies, offline caches or private URL schemes. Supplying one makes
   * `apiKey` optional. Until the conformance kit ships (see below), the way
   * to check a host is `init({dev:true})`, which validates the contract at
   * runtime and warns on every violation.
   */
  host?: MockupHost;

  /**
   * OPTIONAL budget for the longer side of a render output, in pixels.
   *
   * By default the SDK caps nothing of its own: the only ceiling is the
   * GPU's maximum texture size (`limits().deviceMaxOutputSize`, typically
   * 4096–16384), because a legitimate need for a large output should not be
   * refused over a number we picked. A large render is slow, not broken.
   *
   * Set this to impose a budget — it can only LOWER the ceiling, never
   * raise it past the GPU. Requests above the effective limit are scaled
   * down uniformly rather than rejected, and emit {type:'output-capped'}.
   */
  maxOutputSize?: number;

  /**
   * OPTIONAL budget for the output AREA, in pixels. Not applied unless you
   * set it.
   *
   * Area, not the long side, is what cost tracks: render time and memory
   * are both linear in `width × height`, so 4096×4096 costs four times
   * 4096×1024 even though their long sides match. Reach for this when your
   * integration targets constrained devices (a 4.2 MP output is ~17 MB per
   * buffer, and the pipeline holds a few); leave it unset to let the GPU
   * decide.
   *
   * Requests above it are scaled down uniformly and emit
   * {type:'output-capped'} with reason 'max-output-pixels'. Because each
   * side is rounded up to whole pixels, the result can exceed this budget
   * by up to one pixel per side — relatively about (1/width + 1/height), so
   * ~0.1% for a 2000px-wide output but ~1% for a 200px one. Treat it as a
   * cost budget, not an allocation limit; if you need a hard ceiling on the
   * buffer, use `maxOutputSize`, which (like the device limit) is exact.
   */
  maxOutputPixels?: number;

  /**
   * Telemetry sink. The SDK NEVER phones home — wire this into your own
   * pipeline. Events are delivered asynchronously on the creating thread,
   * in engine order; all events belonging to an operation are delivered
   * before that operation's promise settles. An 'error' event is emitted
   * for EVERY MockupError, including ones also thrown to a caller — sinks
   * are complete, so de-duplicate there if you also report catches.
   * 'device-lost'/'device-restored' go to every live client.
   * Ignore unknown event types (they may appear in minor releases).
   */
  onEvent?: (event: MockupEvent) => void;
}

export type HeaderMap = Record<string, string>;

/**
 * Why a request is being made — hosts key auth/credentials on it.
 * CLOSED enum: adding a role is a major release.
 * - 'model': POST to the model-generation endpoint (built-in default, or
 *   `endpoints.model` override).
 * - 'asset': GET of a model asset (built-in base URL, or `endpoints.asset`).
 * - 'image': GET of a caller-supplied image (a surface URL, or a string
 *   passed to `loadImage`).
 */
export type RequestRole = 'model' | 'asset' | 'image';

export type MockupEvent =
  | {
      type: 'prepare';
      surfaceUrl: string;
      /**
       * Open set; ignore unknown stages. 'model' = waiting for the
       * service to build the surface (seconds the first time, no byte
       * progress possible); 'assets' = downloading its maps; 'build' =
       * the local CPU build.
       */
      stage: 'model' | 'assets' | 'build' | (string & {});
      /** Cumulative bytes downloaded, during and after the 'assets' stage. */
      loadedBytes?: number;
      /** Total bytes when known. Not yet in 0.1.x: always absent. */
      totalBytes?: number;
    }
  | { type: 'render'; surfaceUrl: string; timings: RenderTimings }
  | {
      type: 'error';
      kind: MockupErrorKind;
      message: string;
      /** Surface or image URL when the error is attributable to one. */
      url?: string;
    }
  | {
      type: 'output-capped';
      surfaceUrl: string;
      /** What `(width, height) × pixelScale` asked for, in device pixels. */
      requested: { width: number; height: number };
      /** What was produced — the same values as `Render.width/height`. */
      actual: { width: number; height: number };
      /**
       * The limit that bound, in its own units: pixels of long side for
       * 'max-output-size' / 'device-limit', total pixels for
       * 'max-output-pixels'.
       */
      limit: number;
      /** Which budget bound: your area budget, your long side, or the GPU's. */
      reason: 'max-output-pixels' | 'max-output-size' | 'device-limit';
    }
  /**
   * The rendering context was lost (GPU process crash, tab backgrounded
   * on a memory-starved device). Recovery is automatic — see the
   * 'device-lost' row of the kind table. Emitted once per loss, to every
   * live client.
   */
  | { type: 'device-lost' }
  /** The first render after a loss succeeded; the client is healthy again. */
  | { type: 'device-restored' };

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface MockupClient {
  /**
   * Prepares a surface for rendering: calls the model endpoint for
   * `surfaceUrl` (the metered, potentially seconds-long step — the
   * service builds the surface the first time and serves it from cache
   * afterwards), downloads the model assets and the photo, and builds the
   * surface locally. Progress arrives via `onEvent` ({type:'prepare'}).
   *
   * Returns a HANDLE that owns the result. It stays resident — GPU
   * textures, mesh, maps — until you `dispose()` it (or dispose the
   * client). Prepare a surface when the user opens a product; dispose it
   * when they leave it.
   *
   * Sharing: concurrent and repeated calls for one URL within a client
   * share ONE underlying surface (so a React effect that runs twice, or two
   * components showing the same photo, cost one build and one set of
   * textures). Each call still returns its own handle with its own
   * `dispose()`; the underlying surface is released when the last handle
   * is disposed. The URL is the identity — if the content behind a URL
   * changes, dispose every handle to it and prepare again.
   *
   * Aborting a caller (`options.signal`) detaches that caller only; if
   * nobody is left waiting when the build finishes, the result is released
   * immediately (an aborted prepare never leaves memory behind).
   *
   * @throws MockupError kind:'unprocessable-image' (the service could not
   *         turn this photo into a surface — ask for another photo),
   *         'network'|'auth'|'rate-limited'|'quota-exceeded'|'bad-request'
   *         (the service refused the request)|'protocol'|'invalid-model'|
   *         'invalid-asset'|'image-decode'|'cancelled' (see also the blanket
   *         throws note on `MockupError`). Service-side failures carry the
   *         service's own message, plus `detail.status` and the error
   *         `detail.type` it reported.
   */
  prepareSurface(surfaceUrl: string, options?: AbortOptions): Promise<Surface>;

  /**
   * Fetches (through the host, role 'image') and/or decodes a picture into
   * a HANDLE that owns its GPU texture, ready to be placed as a decal.
   * Sources: a URL string (fetched via the host), a `Blob`/`File` (e.g. a
   * file input — never goes near the network), an `ImageBitmap` or an
   * `ImageData` (e.g. text you rasterized on a canvas yourself).
   *
   * Load once, render many times: the decoded pixels are uploaded once and
   * every render referencing the handle reuses the texture. Each call
   * returns an independent handle (no sharing by URL — pictures are cheap
   * to decode and their URLs are often mutable); dispose it when the decal
   * is gone from your document.
   *
   * `ImageBitmap` inputs are used as given: create them with
   * `premultiplyAlpha: 'none'` and `colorSpaceConversion: 'none'` for
   * faithful colors (the SDK owns premultiplication). `ImageData` is read,
   * not retained; `Blob` and `ImageBitmap` inputs are retained by
   * reference for the handle's lifetime (a context loss re-uploads from
   * them).
   *
   * @throws MockupError kind:'network' (transport failure after retries),
   *         kind:'invalid-asset' (HTTP error for the URL — check the
   *         URL/CORS), kind:'image-decode' (bytes fetched but undecodable),
   *         kind:'cancelled', kind:'bad-request' (unsupported source type).
   */
  loadImage(source: ImageSource, options?: AbortOptions): Promise<DecalImage>;

  /**
   * Renders a surface with the given decals composited on.
   *
   * Declarative: pass the COMPLETE decal list every time; callers need no
   * dirty-checking, because the per-decal work is cached on the surface: a
   * decal whose geometry (image, transform, crop, `size`, solver) is
   * unchanged since the previous render of that surface is not solved
   * again and its uv maps stay on the GPU, so moving one decal costs one
   * solve, not one per decal; `adjust` and `shading` are uniforms and cost
   * no solve at all. There is no whole-frame memo — every call
   * draws and delivers its own independent result — but a draw is a
   * matter of milliseconds. The cache holds exactly the previous frame's
   * decals (a decal you drop is released with the next render).
   *
   * Concurrency: renders for the same `Surface` HANDLE coalesce — the
   * latest request wins; superseded in-flight calls reject with
   * kind:'cancelled'. This makes naive per-pointer-move call sites correct
   * by default. Renders for different handles proceed independently — so
   * two views of one photo (a canvas and a thumbnail) should each hold
   * their own handle (`prepareSurface` twice; the underlying surface is
   * shared, see there).
   *
   * @throws MockupError kind:'bad-request' (invalid input: non-finite
   *         dimensions or transform, duplicate decal ids, malformed crop,
   *         a handle from another client), kind:'disposed' (the surface or
   *         an image handle was disposed), kind:'unsupported' (solver
   *         'geodesic' on a surface whose `solvers` lack it), and the
   *         blanket kinds.
   */
  render(request: RenderRequest): Promise<Render>;

  /**
   * Instance health. `ok: false` with reason 'device-lost' means the
   * rendering context is currently lost and recovery is pending: renders
   * issued now wait for it (see the kind table). Updates arrive
   * asynchronously, but the result is guaranteed to reflect any
   * 'device-lost'/'device-restored' event already delivered to `onEvent`.
   */
  probe(): ProbeResult;

  /**
   * Output-size ceiling in effect for this client. Size your render
   * requests against `maxOutputSize`; anything larger is capped (see
   * {type:'output-capped'}). Constant for the client's lifetime.
   */
  limits(): MockupLimits;

  /**
   * What this client currently holds: live handle counts and an ESTIMATE of
   * the memory they pin (RGBA bytes of resident textures — what the GPU
   * would report if it could). You own residency, so this is your budget
   * meter: dispose handles when it grows past what the device tolerates.
   * Dev mode warns once when the estimate passes 512 MiB.
   */
  stats(): MockupStats;

  /**
   * Releases everything owned by this client: every live `Surface` and
   * `DecalImage` handle it created. Idempotent. In-flight operations
   * reject with kind:'cancelled'. After disposal every method throws
   * kind:'disposed'. `Render`s already delivered are unaffected (they own
   * their bitmap).
   */
  dispose(): void;
  [Symbol.dispose](): void;
}

/** What `loadImage` accepts. Strings are URLs, fetched through the host. */
export type ImageSource = string | Blob | ImageBitmap | ImageData;

/**
 * One prepared photo — the HANDLE `prepareSurface()` returns. Owns the
 * surface's GPU and CPU state until disposed; see `prepareSurface()` for
 * sharing and lifetime.
 *
 * Handles are bound to the client that created them, are not serializable
 * (persist the `url` and prepare again), and become unusable after
 * `dispose()` — a render referencing a disposed surface rejects
 * kind:'disposed'. In-flight renders on it reject kind:'cancelled'.
 */
export interface Surface {
  /** The URL this surface was prepared from — its identity. */
  readonly url: string;
  /** Natural pixel size of the photo (the default mockup-space extent). */
  readonly width: number;
  readonly height: number;
  /**
   * Which `RenderRequest.solver` values this surface supports. 'classic'
   * always; 'geodesic' only when the model carries a camera intrinsics
   * matrix. Disable the option in your UI when it is absent, instead of
   * catching kind:'unsupported'.
   */
  readonly solvers: readonly ('classic' | 'geodesic')[];
  /**
   * Releases this handle. Idempotent. The underlying surface is freed when
   * the last handle sharing it is disposed.
   */
  dispose(): void;
  [Symbol.dispose](): void;
}

/**
 * One decoded picture — the HANDLE `loadImage()` returns. Owns its GPU
 * texture until disposed; bound to its client; not serializable. Renders
 * referencing a disposed image reject kind:'disposed'.
 */
export interface DecalImage {
  /** Natural pixel size — the decal's local coordinate space. */
  readonly width: number;
  readonly height: number;
  /** Releases the texture. Idempotent. */
  dispose(): void;
  [Symbol.dispose](): void;
}

export type ProbeReason = 'unsupported' | 'device-lost' | (string & {});

export interface ProbeResult {
  ok: boolean;
  reason?: ProbeReason;
}

export interface AbortOptions {
  signal?: AbortSignal;
}

export interface MockupLimits {
  /**
   * Effective cap on the longer side of a render output, in device pixels —
   * `min(config.maxOutputSize ?? deviceMaxOutputSize, deviceMaxOutputSize)`.
   * Equals `deviceMaxOutputSize` unless you set a budget.
   */
  maxOutputSize: number;
  /**
   * Your area budget, when `config.maxOutputPixels` is set. ABSENT means no
   * area limit is applied.
   */
  maxOutputPixels?: number;
  /**
   * What the GPU allows (its maximum texture / framebuffer dimension). The
   * graphics spec floor is 2048; contemporary devices report 4096–16384.
   * An absolute ceiling: `config.maxOutputSize` above this has no effect.
   */
  deviceMaxOutputSize: number;
}

export interface MockupStats {
  /** Live (undisposed) `Surface` handles created by this client. */
  surfaces: number;
  /** Live (undisposed) `DecalImage` handles created by this client. */
  images: number;
  /**
   * Estimated resident bytes, RGBA-equivalent: `surfaces` counts each
   * distinct underlying surface once (photo texture + its maps); `images`
   * counts every image handle's texture. Every picture also carries a
   * half-size variant for the renderer's color-correction pass, included
   * here (×1.25). Not counted: the per-decal solve cache (two uv maps at
   * the surface's solve resolution per decal of the last frame), which is
   * bounded by that frame's decal count.
   */
  bytes: { surfaces: number; images: number };
  lastRender?: RenderTimings;
}

export interface RenderTimings {
  totalMs: number;
  /**
   * CPU solve portion (surface math).
   * Not yet in 0.1.x: always 0 — the solve is included in `drawMs`.
   */
  solveMs: number;
  /** Compositing portion (includes the solve in 0.1.x). */
  drawMs: number;
  /** Result materialization: lifting the frame off the GPU as a bitmap. */
  deliverMs: number;
}

// ---------------------------------------------------------------------------
// Render request
// ---------------------------------------------------------------------------

/**
 * Coordinate model
 * ----------------
 * "Mockup space" is the caller's logical coordinate system for one mockup:
 * origin at the top-left, x right, y down, extent (0,0)–(width,height) as
 * given in the request — typically your canvas element's local space. The
 * surface image is stretched (non-uniformly if necessary) to fill that
 * full extent, like CSS `object-fit: fill`. Decal transforms map INTO this
 * space; returned `DecalBound`s are expressed IN it.
 */
export interface RenderRequest {
  /** The prepared surface to render — a live handle from this client. */
  surface: Surface;

  /**
   * Mockup-space extent: the coordinate system `DecalSpec.transform` and
   * `Render.bounds` live in, and the output's logical size before
   * `pixelScale`.
   *
   * Default: the surface's natural pixel size (`surface.width/height`), so
   * decal transforms are in photo pixels and the output keeps the photo's
   * aspect. That is what you want unless you are deliberately rendering
   * into a differently shaped box.
   *
   * Explicit values let you render into a layout box of your own, including
   * a normalized space (`{width: 1, height: 1}`). An aspect ratio other
   * than the surface's stretches the mockup and every decal on it; dev mode
   * warns about that, since it is usually a bug rather than intent. Both
   * fields must be finite and > 0.
   */
  size?: Size;

  /**
   * Device pixels per mockup-space unit. Pass
   * `viewportZoom * devicePixelRatio` for crisp on-screen results when your
   * mockup space is CSS pixels. Default 1 = logical size, appropriate for
   * export. Output bitmap is `ceil((width, height) × pixelScale)`, uniformly
   * downscaled only if it exceeds what the GPU can render or a budget you
   * set (see `limits()`); a downscale emits {type:'output-capped'} and
   * `Render.width/height` reports what was actually produced.
   *
   * Note that `pixelScale` multiplies MOCKUP space, which defaults to the
   * photo's own pixels — it is not a display-density knob. Leave it at 1 to
   * render the photo at its native resolution; `devicePixelRatio` has no
   * place here unless you deliberately set `size` in CSS pixels.
   */
  pixelScale?: number;

  /**
   * Complete decal list, back-to-front (order is paint order). An empty
   * array renders the bare surface.
   */
  decals: readonly DecalSpec[];

  /**
   * Which solver maps designs onto the surface:
   * - 'classic' (default): the discrete exponential map.
   * - 'geodesic': the heat-method logarithmic map — designs wrap along the
   *   surface like a sticker of fixed physical size. Its per-surface state
   *   is built on the first geodesic render of a surface (tens of ms) and
   *   then kept with it. Rejects kind:'unsupported' when
   *   `surface.solvers` does not include it.
   */
  solver?: 'classic' | 'geodesic';

  /** Abort this render (rejects with kind:'cancelled'). */
  signal?: AbortSignal;
}

export interface DecalSpec {
  /**
   * Stable identity across renders — the key of `Render.bounds`. Duplicate
   * ids in one request reject with kind:'bad-request'.
   */
  id: string;

  /** The picture to composite — a live `loadImage()` handle from this client. */
  image: DecalImage;

  /**
   * 2D affine transform from decal local space to mockup space, in
   * CanvasRenderingContext2D.setTransform order [a, b, c, d, e, f]:
   *   x' = a*x + c*y + e
   *   y' = b*x + d*y + f
   *
   * Decal local space is the image's NATURAL PIXELS (with `crop`, its region,
   * origin at the crop's top-left). So `[a, b]` is where one image pixel of
   * width lands in mockup space and `[c, d]` one pixel of height — the decal's
   * on-screen size is `image.width * scale`, and this matrix is the only thing
   * that sizes, rotates and positions it.
   *
   * ⚠ This is NOT the row-major order [a, c, e, b, d, f] used by some
   * matrix libraries. Passing a row-major array is silently accepted and
   * silently transposes rotation/skew — double-check when porting.
   */
  transform: readonly [number, number, number, number, number, number];

  /**
   * Optional source rectangle [x, y, w, h] in the image's NATURAL pixels;
   * only that region is drawn. Default: the full image.
   *
   * Cropping does not resize the decal — it shows less of the image at the
   * same scale, the way cropping a photo does. Local (0,0) moves to the crop's
   * top-left, so a decal keeps its position when you crop from the right or
   * bottom, and shifts with the origin when you crop from the left or top.
   */
  crop?: readonly [number, number, number, number];

  /**
   * Optional color adjustment, applied to the decal sample in sRGB space
   * with CSS-filter semantics (brightness → contrast → saturate →
   * hue-rotate). Neutral values (1/1/1/0) and an absent object are
   * equivalent.
   */
  adjust?: {
    /** Multiplier, neutral 1 (CSS brightness()). Suggested range 0–2. */
    brightness?: number;
    /** Neutral 1 (CSS contrast()). Suggested range 0–2. */
    contrast?: number;
    /** Neutral 1; 0 = grayscale (CSS saturate()). Suggested range 0–2. */
    saturate?: number;
    /** Hue rotation in degrees, neutral 0 (SVG hueRotate). */
    hue?: number;
  };

  /**
   * How much of the surface's lighting the decal receives, 0–1. Default 1:
   * the decal is lit exactly like the material under it — a print in a
   * shadow fold darkens with the fold. That is also what bounds how bright a
   * decal can appear on a DARK surface: the pipeline reads the photo's
   * darkness as shading, so on a black shirt even a white decal renders
   * near-black and no `adjust.brightness` can lift it (brightness saturates
   * at white, and white is what is being darkened). Lower values apply the
   * lighting at reduced strength (`shade^shading`, so folds keep their
   * relative contrast while the floor lifts); 0 ignores lighting and the
   * decal reads as a flat sticker. Only the decal's own contribution
   * changes — the surface around it, and the surface showing through
   * transparent decal pixels, are untouched. Non-finite or outside [0, 1]
   * rejects with kind:'bad-request'.
   */
  shading?: number;
}

// ---------------------------------------------------------------------------
// Render result
// ---------------------------------------------------------------------------

/**
 * One finished render.
 *
 * Materialization (normative)
 * ---------------------------
 * `render()` resolves only after this render's bitmap has been lifted off
 * the GPU on the calling thread. Each `Render` owns an INDEPENDENT bitmap;
 * nothing is ever shared between two `Render`s, so consuming or disposing
 * one can never affect another, nor the surface or images it was rendered
 * from.
 *
 * Ownership
 * ---------
 * - `drawTo()` / `encode()` do NOT consume — call them repeatedly.
 * - `takeImageBitmap()` CONSUMES: transfers the bitmap out exactly once;
 *   afterwards `drawTo`/`encode`/`takeImageBitmap` throw kind:'disposed'
 *   with `detail.cause: 'taken'`. The caller owns (and must eventually
 *   `close()`) the returned bitmap.
 * - `dispose()` is idempotent; releases the bitmap unless taken. Prefer
 *   `using render = await client.render(...)`.
 * - `width`, `height` and `bounds` are plain data captured at render time;
 *   they remain readable after consumption AND disposal.
 */
export interface Render {
  /** Output bitmap size in device pixels (after `maxOutputSize` capping). */
  readonly width: number;
  readonly height: number;

  /**
   * Where each decal landed, keyed by `DecalSpec.id`. Every requested id
   * is present; the value is `null` when the decal is fully occluded by
   * the surface's foreground or lies entirely outside the surface.
   * Partially visible decals report their full (unclipped) placement.
   */
  readonly bounds: Readonly<Record<string, DecalBound | null>>;

  /** Transfers the bitmap out (consuming — see Ownership above). */
  takeImageBitmap(): ImageBitmap;

  /**
   * Draws the result into a caller-owned 2D context (non-consuming).
   *
   * This is bitmap DELIVERY, not rendering — all mockup rendering (and
   * shader work) happens inside the SDK's own hidden context before
   * `render()` resolves. The display target therefore needs no graphics
   * capabilities of its own:
   * - WebGL/WebGPU consumers: `takeImageBitmap()` and upload it as a
   *   texture yourself.
   * - Zero-copy display: `takeImageBitmap()` +
   *   `ImageBitmapRenderingContext.transferFromImageBitmap()` (that
   *   transfer consumes the bitmap, which is why it is not offered on
   *   this non-consuming method).
   */
  drawTo(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    dx?: number,
    dy?: number,
    dw?: number,
    dh?: number,
  ): void;

  /** Encodes to an image Blob (non-consuming) — e.g. for upload/export. */
  encode(options?: EncodeOptions): Promise<Blob>;

  dispose(): void;
  [Symbol.dispose](): void;
}

export interface EncodeOptions {
  /** Default 'image/png'. */
  type?: 'image/png' | 'image/webp' | 'image/jpeg';
  /** [0,1], lossy formats only. */
  quality?: number;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * A width/height pair. One object rather than two optional numbers wherever
 * the pair is optional, so a half-specified size cannot compile. A
 * `Surface` is assignable to it.
 */
export interface Size {
  width: number;
  height: number;
}

/**
 * Where a decal landed, in mockup space.
 *
 * `quad` is the ground truth: the images of the decal's local corners
 * (0,0), (w,0), (w,h), (0,h) under its final placement — it encodes
 * mirroring and skew exactly. Build selection chrome / hit geometry from
 * it.
 *
 * The remaining fields are a convenience oriented box: the box with
 * top-left corner (x, y), size (w, h), rotated by `rotation` degrees
 * clockwise (y-down) ABOUT (x, y). For placements without mirror or skew
 * (the common case) this reconstructs `quad` exactly; otherwise `quad` is
 * authoritative.
 */
export interface DecalBound {
  quad: readonly [Point, Point, Point, Point];
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees, clockwise (y-down), about (x, y). */
  rotation: number;
}

// ---------------------------------------------------------------------------
// Host (transport injection)
// ---------------------------------------------------------------------------

/**
 * Everything the SDK needs from the outside world. The SDK owns URL
 * construction, retries, backoff (incl. 429 Retry-After), timeouts,
 * de-duplication and fan-out — a host implements ONLY raw transport.
 *
 * CONTRACT — enforced at runtime by `init({dev:true})`, which warns on every
 * violation below. (A `verifyMockupHost` conformance kit under
 * 'mocksimple/testing' is planned; it is NOT part of this release, and that
 * subpath does not resolve yet.)
 *
 * 1. Resolve for EVERY HTTP outcome, including 4xx/5xx — never map status
 *    codes to rejections.
 * 2. Reject ONLY for: abort (a DOMException named 'AbortError') or
 *    transport failure (TypeError / an Error named 'NetworkError').
 *    Wrappers around never-rejecting HTTP clients that resolve failures
 *    into envelope objects silently defeat the SDK's retry logic.
 * 3. Honor `signal` — the SDK owns cancellation and timeouts through it.
 *    (Not yet in 0.1.x: the SDK never aborts its own requests, so `signal`
 *    is present but never fires. Honor it anyway.)
 * 4. If your auth layer refreshes tokens, make the refresh single-flight:
 *    the SDK fans out several asset requests concurrently.
 * 5. The SDK takes ownership of `HostResponse.body`: its underlying
 *    ArrayBuffer may be detached (transferred) after `fetch` resolves.
 *    Never return a view over a buffer you retain — in-memory caches must
 *    return a fresh copy per call.
 * 6. Pass SDK-provided `headers` through unmodified on 'model'/'asset'
 *    requests — they carry the integration's API key; stripping them
 *    breaks auth and billing.
 * 7. `decodeImage`, if provided, MUST return an ImageBitmap with
 *    unpremultiplied alpha and no color-space conversion (equivalent to
 *    `createImageBitmap(blob, { colorSpaceConversion: 'none',
 *    premultiplyAlpha: 'none' })`) — the SDK owns premultiplication.
 */
export interface MockupHost {
  fetch(request: HostRequest): Promise<HostResponse>;
  /** Optional custom image decoder — see contract clause 7. */
  decodeImage?(bytes: Uint8Array, mime: string): Promise<ImageBitmap>;
}

export interface HostRequest {
  url: string;
  method: 'GET' | 'POST';
  role: RequestRole;
  headers?: Record<string, string>;
  body?: Uint8Array;
  /** Always present; created and owned by the SDK (never fires in 0.1.x). */
  signal: AbortSignal;
  /**
   * Correlation context: which surface this request serves. Present on
   * 'model' and 'asset' requests — lets custom hosts implement per-surface
   * routing or auth.
   */
  context?: { surfaceUrl: string };
  /**
   * Present for content-addressed assets that never change — a host may
   * cache them forever (Cache API / IndexedDB) keyed by `key`.
   */
  cacheHint?: { key: string; immutable: boolean };
}

export interface HostResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Known kinds. `MockupErrorKind` itself is OPEN — new kinds may be added
 * in minor versions; treat unknown values as 'internal'.
 *
 * kind            retryable  meaning / recommended consumer action
 * --------------- ---------  -------------------------------------------
 * unsupported     no         missing capability; `detail.capability` says
 *                            which ('webassembly'|'webgl2'|'offscreen-canvas'
 *                            |'csp') — hide the feature or prompt (e.g.
 *                            "enable hardware acceleration" for 'webgl2').
 *                            Also: solver 'geodesic' on a surface without
 *                            it; and a rendering context that was lost and
 *                            could NOT be recovered (`detail.capability:
 *                            'webgl2'`, `detail.reason: 'context-lost'`) —
 *                            suggest a page reload
 * bad-request     no         invalid input from the caller (non-finite
 *                            dims/transform, duplicate decal ids,
 *                            malformed crop, a handle from another client,
 *                            an unsupported image source) — or a request the
 *                            service refused as malformed (HTTP 400,
 *                            `detail.type` says why); fix the call site
 * unprocessable-  no         the service could not turn THIS photo into a
 *   image                    surface (HTTP 422 / a model-service failure:
 *                            no product found, too small, unsupported
 *                            format) — a normal outcome for some photos;
 *                            tell the user to pick another one. Never
 *                            billed.
 * network         yes        transport failure after SDK-side retries;
 *                            offer manual retry
 * auth            no         401/403; invalid/revoked/origin-mismatched
 *                            API key — check your key and registered
 *                            origins
 * rate-limited    yes        429; SDK already backed off per Retry-After
 *                            — slow down
 * quota-exceeded  no         the key's usage allowance is exhausted
 *                            (billing); prompt an upgrade — distinct from
 *                            rate-limited, retrying will not help
 * protocol        no         endpoint responded with an unparseable or
 *                            foreign shape, or an HTTP status our service
 *                            never sends (a wrong `endpoints.model`, a
 *                            proxy in the way); report
 * invalid-model   no         model data failed validation (backend issue)
 * invalid-asset   no         a model asset or an image URL failed (HTTP
 *                            error; `detail.requestUrl` / `detail.status`
 *                            name it); check the URL/CORS
 * image-decode    no         bytes fetched but undecodable
 * cancelled       —          aborted or superseded; normal flow
 * device-lost     yes        the rendering context was lost while THIS
 *                            render was in flight; retry it. Recovery is
 *                            automatic: renders issued after a loss wait
 *                            (bounded) for the browser to restore the
 *                            context, fall back to a fresh one, re-upload
 *                            what they need and complete; {type:'device-
 *                            lost'} / {type:'device-restored'} bracket the
 *                            episode. Repeated losses within a minute
 *                            (memory pressure) end in 'unsupported' with
 *                            `detail.reason: 'context-lost'` — dispose
 *                            handles you no longer show (`stats()`)
 * out-of-memory   no         reduce sizes / decal counts / resident handles
 * disposed        no         use-after-dispose (`detail.cause` is
 *                            'taken' | 'disposed')
 * internal        no         bug in the SDK; report with `detail`
 *
 * Blanket rule: ANY method may additionally throw 'disposed',
 * 'out-of-memory', 'device-lost' and 'internal'; per-method @throws lists
 * name only the distinctive kinds.
 */
export type KnownMockupErrorKind =
  | 'unsupported'
  | 'bad-request'
  | 'network'
  | 'auth'
  | 'rate-limited'
  | 'quota-exceeded'
  | 'unprocessable-image'
  | 'protocol'
  | 'invalid-model'
  | 'invalid-asset'
  | 'image-decode'
  | 'cancelled'
  | 'device-lost'
  | 'out-of-memory'
  | 'disposed'
  | 'internal';

export type MockupErrorKind = KnownMockupErrorKind | (string & {});

/**
 * The only error type the SDK throws — a real `Error` subclass: stacks,
 * `instanceof` and Sentry grouping all work.
 *
 * Note: cancellation surfaces as kind:'cancelled' on a MockupError, NOT as
 * a DOMException named 'AbortError' — generic abort detectors won't match;
 * use `MockupError.is(e, 'cancelled')`.
 */
export declare class MockupError extends Error {
  constructor(
    kind: MockupErrorKind,
    message: string,
    options?: { retryable?: boolean; detail?: unknown; cause?: unknown },
  );
  readonly kind: MockupErrorKind;
  readonly retryable: boolean;
  /** Machine-readable context (status codes, asset ids, capability). */
  readonly detail?: unknown;
  /**
   * Type guard. With a `kind`, narrows to a MockupError OF that kind, so an
   * `else` branch keeps the rest of the union:
   * `if (MockupError.is(e, 'cancelled')) return;`
   */
  static is<K extends MockupErrorKind>(e: unknown, kind: K): e is MockupError & { kind: K };
  static is(e: unknown): e is MockupError;
}
