/**
 * `MockupClient` — a configuration scope that creates surfaces and images
 * and renders them.
 *
 * Residency is the caller's: a `Surface` or `DecalImage` handle pins its GPU
 * texture (and, for surfaces, the engine's CPU state) until disposed, and
 * this client evicts nothing on its own. What the client owns is the
 * bookkeeping around that — the refcounted sharing of one underlying surface
 * between handles to the same URL, the texture keys, and the rebuild of GPU
 * state after a context loss — plus render orchestration: latest-wins per
 * surface handle (so a naive per-pointer-move call site is correct by
 * default, and superseded calls reject kind:'cancelled'), and one typed-error
 * path so `onEvent` sees each error exactly once.
 */
import { Engine } from '../pkg/mockup.js';
import { badRequest, cancelled, MockupError, toMockupError } from './errors.js';
import { devWarn, isDevMode, wrapHostForDev } from './dev.js';
import {
  ensureGpuUsable,
  getGpu,
  isGpuLost,
  onDeviceLost,
  queryDeviceMaxOutputSize,
  type Gpu,
} from './environment.js';
import {
  allocateImageKey,
  DecalImageImpl,
  SurfaceImpl,
  type SharedSurface,
  type SharedSurfaceData,
} from './handles.js';
import { createDefaultHost } from './host.js';
import {
  decodeSource,
  downscaleHalf,
  fetchImageBlob,
  isImageSource,
  retainSource,
  type DecodedImage,
  type RetainedSource,
} from './images.js';
import {
  aspectDeviation,
  engineDecal,
  planOutput,
  resolveExtent,
  surfaceTransform,
  toDecalBound,
  validateRenderRequest,
  type EnginePlacement,
} from './render-plan.js';
import { RenderImpl } from './render-result.js';
import type {
  AbortOptions,
  DecalBound,
  DecalImage,
  HostRequest,
  ImageSource,
  MockupClient,
  MockupConfig,
  MockupEvent,
  MockupHost,
  MockupLimits,
  MockupStats,
  ProbeResult,
  Render,
  RenderRequest,
  RenderTimings,
  RequestRole,
  Size,
  Surface,
} from '../types/mocksimple';

/** Header carrying the API key. Attached to 'model' requests ONLY — see the
 * comment at the attach site. */
const API_KEY_HEADER = 'x-api-key';

/** Dev-mode nag threshold for the resident-bytes estimate (the contract's
 * "warns once when the estimate passes 512 MiB"). */
const RESIDENT_WARN_BYTES = 512 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Request object the wasm Engine hands the adapter (engine.rs docs). */
interface EngineFetchRequest {
  url: string;
  method: 'GET' | 'POST';
  role: RequestRole;
  headers?: Record<string, string>;
  body?: Uint8Array;
  cacheHint?: { key: string; immutable: boolean };
  context?: { surfaceUrl: string };
}

/** What `Engine.prepareSurface` resolves with (engine.rs). */
interface EnginePrepared {
  width: number;
  height: number;
  geodesic: boolean;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Reject with kind:'cancelled' as soon as `signal` fires; the underlying
 * work continues (shared pipelines have other callers). */
function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onCancel?: (error: MockupError) => void,
): Promise<T> {
  if (!signal) return promise;
  const makeCancelled = () => {
    const error = cancelled('operation aborted by the caller');
    onCancel?.(error);
    return error;
  };
  if (signal.aborted) return Promise.reject(makeCancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(makeCancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error as Error);
      },
    );
  });
}

/** The context went away under a frame that was already being drawn. */
function deviceLost(): MockupError {
  return new MockupError('device-lost', 'rendering context lost during the render; retry', {
    retryable: true,
  });
}

/** The surface URL for error events, extracted defensively from a request
 * that has not been validated yet. */
function surfaceUrlOf(request: unknown): string | undefined {
  const surface = (request as { surface?: unknown } | null)?.surface;
  const url = (surface as { url?: unknown } | null)?.url;
  return typeof url === 'string' ? url : undefined;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class MockupClientImpl implements MockupClient {
  /** Absent when the caller's own host owns authentication. */
  readonly #apiKey?: string;
  readonly #endpoints: { model: string; asset: string | ((surfaceUrl: string) => string) };
  readonly #host: MockupHost;
  readonly #onEvent?: (event: MockupEvent) => void;
  /**
   * Optional caller budgets. Unset means the only ceiling is the GPU's:
   * a legitimate need for a big output must not be blocked by a number we
   * picked, so we cap nothing by default and let the render be slow.
   */
  readonly #maxOutputBudget?: number;
  readonly #maxPixelBudget?: number;
  readonly #engine: Engine;

  /** Identity stamped on every handle this client creates — handles never
   * cross clients (each client has its own engine and texture keys). */
  readonly #owner = {};
  /** Underlying surfaces by URL: one build, however many handles. */
  readonly #shared = new Map<string, SharedSurface>();
  /** Live surface handles. */
  readonly #surfaces = new Set<SurfaceImpl>();
  /** Live decal-image handles (surface photos are tracked by their surface). */
  readonly #images = new Set<DecalImageImpl>();
  readonly #emitted = new WeakSet<MockupError>();
  readonly #unsubscribeLoss: () => void;
  /** GPU generation the engine's renderer was built for; -1 = none yet. */
  #gpuGeneration = -1;
  /** A loss was announced and no render has succeeded since. */
  #lostSinceLastRender = false;
  #lastRender?: RenderTimings;
  #residentWarned = false;
  #disposed = false;

  constructor(
    config: MockupConfig,
    endpoints: { model: string; asset: string | ((surfaceUrl: string) => string) },
  ) {
    this.#apiKey = config.apiKey; // undefined when a host owns auth
    this.#endpoints = endpoints;
    // config.headers is the DEFAULT host's auth hook; a custom host owns
    // its own auth, so headers are ignored alongside one (per the .d.ts).
    if (isDevMode() && config.host && config.headers) {
      devWarn(
        'config.headers is ignored because a custom `host` was provided — put auth inside the host.',
      );
    }
    // Only an INJECTED host gets the dev-mode contract wrapper.
    this.#host = config.host
      ? isDevMode()
        ? wrapHostForDev(config.host)
        : config.host
      : createDefaultHost({ headers: config.headers });
    this.#onEvent = config.onEvent;
    this.#maxOutputBudget = config.maxOutputSize;
    this.#maxPixelBudget = config.maxOutputPixels;
    this.#engine = new Engine(this.#engineFetch);
    this.#unsubscribeLoss = onDeviceLost(() => {
      this.#lostSinceLastRender = true;
      this.#emit({ type: 'device-lost' });
    });
  }

  /** HostRequest→Promise adapter the wasm Engine drives (engine.rs docs). */
  readonly #engineFetch = (raw: EngineFetchRequest) => {
    const headers: Record<string, string> = { ...(raw.headers ?? {}) };
    // The API key rides on 'model' requests ONLY. 'asset' goes to a public
    // immutable bucket that neither reads nor needs it, and a custom header
    // would make that cross-origin GET non-simple: the browser then sends a
    // CORS preflight per asset URL (measured ~200 ms each against our own
    // asset host) for nothing. 'image' goes to caller-chosen origins, where
    // the key must never leak. With no key at all, no header: the caller's
    // host authenticates however it likes.
    if (raw.role === 'model' && this.#apiKey !== undefined) {
      headers[API_KEY_HEADER] = this.#apiKey;
    }
    const request: HostRequest = {
      url: raw.url,
      method: raw.method,
      role: raw.role,
      headers,
      body: raw.body,
      // Always present per the contract; never aborted in 0.1.x
      // (cancellation resolves in the shim).
      signal: new AbortController().signal,
      context: raw.context,
      cacheHint: raw.cacheHint,
    };
    return Promise.resolve(this.#host.fetch(request)).then((res) => ({
      status: res.status,
      headers: res.headers,
      body: res.body,
    }));
  };

  #assertLive(): void {
    if (this.#disposed) {
      throw new MockupError('disposed', 'client already disposed', {
        detail: { cause: 'disposed' },
      });
    }
  }

  #emit(event: MockupEvent): void {
    const sink = this.#onEvent;
    if (!sink) return;
    queueMicrotask(() => {
      try {
        sink(event);
      } catch {
        // Sink errors never break the SDK.
      }
    });
  }

  /** Emit {type:'error'} exactly once per MockupError instance. */
  #emitError(error: MockupError, url?: string): MockupError {
    if (!this.#emitted.has(error)) {
      this.#emitted.add(error);
      this.#emit({ type: 'error', kind: error.kind, message: error.message, url });
    }
    return error;
  }

  probe(): ProbeResult {
    this.#assertLive();
    if (isGpuLost()) return { ok: false, reason: 'device-lost' };
    return { ok: true };
  }

  // ---- surfaces -------------------------------------------------------------

  prepareSurface(surfaceUrl: string, options?: AbortOptions): Promise<Surface> {
    try {
      this.#assertLive();
      if (typeof surfaceUrl !== 'string' || surfaceUrl.length === 0) {
        throw badRequest('surfaceUrl must be a non-empty string');
      }
    } catch (e) {
      return Promise.reject(this.#emitError(toMockupError(e), surfaceUrl));
    }
    return this.#acquireSurface(surfaceUrl, options?.signal);
  }

  /** One underlying build per URL, a fresh handle per call. */
  async #acquireSurface(url: string, signal?: AbortSignal): Promise<Surface> {
    let shared = this.#shared.get(url);
    if (!shared || shared.released) {
      shared = this.#startShared(url);
      this.#shared.set(url, shared);
    }
    // Counted as a waiter until this call has either become a handle or left,
    // so a build nobody is waiting for anymore can be released on completion.
    shared.waiters += 1;
    let data: SharedSurfaceData;
    try {
      data = await raceAbort(shared.pipeline, signal, (e) => this.#emitError(e, url));
    } catch (e) {
      shared.waiters -= 1;
      this.#maybeRelease(shared);
      throw e; // already reported: pipeline failures and aborts emit as they happen
    }
    shared.waiters -= 1;
    if (this.#disposed) {
      this.#maybeRelease(shared);
      throw this.#emitError(cancelled('client disposed'), url);
    }
    const handle = new SurfaceImpl(shared, data, this.#owner);
    shared.refs += 1;
    this.#surfaces.add(handle);
    handle.onDispose = () => {
      this.#surfaces.delete(handle);
      shared.refs -= 1;
      this.#maybeRelease(shared);
    };
    this.#checkResidentBudget();
    return handle;
  }

  #startShared(url: string): SharedSurface {
    const shared: SharedSurface = {
      url,
      // Assigned right below; the pipeline needs the record to update it.
      pipeline: undefined as unknown as Promise<SharedSurfaceData>,
      data: null,
      refs: 0,
      waiters: 0,
      released: false,
    };
    shared.pipeline = this.#buildShared(shared);
    return shared;
  }

  /** Engine pipeline (model POST + asset fan-out + build) and the photo
   * fetch/decode/upload, concurrently. */
  async #buildShared(shared: SharedSurface): Promise<SharedSurfaceData> {
    const url = shared.url;
    try {
      const assetBase =
        typeof this.#endpoints.asset === 'function'
          ? this.#endpoints.asset(url)
          : this.#endpoints.asset;
      const onProgress = (stage: string, loadedBytes: number) => {
        this.#emit({
          type: 'prepare',
          surfaceUrl: url,
          stage,
          ...(stage === 'model' ? {} : { loadedBytes }),
        });
      };
      const [engineOutcome, photoOutcome] = await Promise.allSettled([
        this.#engine.prepareSurface(
          this.#endpoints.model,
          assetBase,
          url,
          onProgress,
        ) as Promise<EnginePrepared>,
        this.#loadPhoto(url),
      ]);
      const failed =
        engineOutcome.status === 'rejected' || photoOutcome.status === 'rejected' || this.#disposed;
      if (failed) {
        // Whichever half succeeded must not linger in the engine.
        if (engineOutcome.status === 'fulfilled' && !this.#disposed) this.#engine.releaseSurface(url);
        if (photoOutcome.status === 'fulfilled') photoOutcome.value.dispose();
        if (this.#disposed) throw cancelled('client disposed');
        throw engineOutcome.status === 'rejected'
          ? engineOutcome.reason
          : (photoOutcome as PromiseRejectedResult).reason;
      }
      const engineInfo = engineOutcome.value;
      const photo = photoOutcome.value;
      const data: SharedSurfaceData = {
        width: photo.width,
        height: photo.height,
        solveW: engineInfo.width,
        solveH: engineInfo.height,
        solvers: engineInfo.geodesic ? ['classic', 'geodesic'] : ['classic'],
        photo,
      };
      shared.data = data;
      // An aborted prepare never leaves memory behind: if every caller left
      // while this was building, release right away.
      this.#maybeRelease(shared);
      return data;
    } catch (e) {
      shared.released = true;
      if (this.#shared.get(url) === shared) this.#shared.delete(url);
      throw this.#emitError(toMockupError(e), url);
    }
  }

  /** Release the underlying surface once nothing refers to it anymore. */
  #maybeRelease(shared: SharedSurface): void {
    if (shared.released || shared.refs > 0 || shared.waiters > 0 || shared.data === null) return;
    shared.released = true;
    if (this.#shared.get(shared.url) === shared) this.#shared.delete(shared.url);
    if (!this.#disposed) this.#engine.releaseSurface(shared.url);
    shared.data.photo.dispose();
  }

  async #loadPhoto(url: string): Promise<DecalImageImpl> {
    const blob = await fetchImageBlob(this.#host, url);
    const source: RetainedSource = { kind: 'blob', blob };
    const decoded = await decodeSource(this.#host, source, url);
    if (this.#disposed) throw cancelled('client disposed');
    return this.#createImage(decoded, source, `photo ${url}`, false);
  }

  // ---- images ---------------------------------------------------------------

  loadImage(source: ImageSource, options?: AbortOptions): Promise<DecalImage> {
    const url = typeof source === 'string' ? source : undefined;
    try {
      this.#assertLive();
      if (!isImageSource(source)) {
        throw badRequest(
          'loadImage: source must be a non-empty URL string, a Blob, an ImageBitmap or an ImageData',
        );
      }
    } catch (e) {
      return Promise.reject(this.#emitError(toMockupError(e), url));
    }
    return this.#loadImage(source, options?.signal);
  }

  async #loadImage(source: ImageSource, signal?: AbortSignal): Promise<DecalImage> {
    const url = typeof source === 'string' ? source : undefined;
    let retained: RetainedSource | null = null;
    try {
      retained =
        typeof source === 'string'
          ? {
              kind: 'blob',
              blob: await raceAbort(fetchImageBlob(this.#host, source), signal, (e) =>
                this.#emitError(e, url),
              ),
            }
          : await retainSource(source);
      const decoded = await decodeSource(this.#host, retained, url ?? `${retained.kind} image`);
      if (this.#disposed) throw cancelled('client disposed');
      if (signal?.aborted) throw cancelled('image load aborted');
      const image = this.#createImage(
        decoded,
        retained,
        url ?? `image ${decoded.width}x${decoded.height}`,
        true,
      );
      this.#checkResidentBudget();
      return image;
    } catch (e) {
      // A bitmap we made from an ImageData has no other owner.
      if (retained?.kind === 'bitmap' && retained.owned) retained.bitmap.close();
      throw this.#emitError(toMockupError(e), url);
    }
  }

  /** Mint a handle and make its texture resident. `tracked` handles count as
   * decal images in `stats()`; a surface's photo is counted by its surface. */
  #createImage(
    decoded: DecodedImage,
    source: RetainedSource,
    label: string,
    tracked: boolean,
  ): DecalImageImpl {
    const image = new DecalImageImpl(
      allocateImageKey(),
      decoded.width,
      decoded.height,
      source,
      this.#owner,
      label,
    );
    if (tracked) this.#images.add(image);
    image.onDispose = () => {
      this.#images.delete(image);
      if (!this.#disposed) this.#engine.releaseImage(image.key);
    };
    this.#upload(image, decoded);
    return image;
  }

  /** Upload now if the GPU is usable. On a lost context the texture stays
   * non-resident (`uploadedGeneration` -1) and the next render, which waits
   * for recovery, uploads it then. */
  #upload(image: DecalImageImpl, decoded: DecodedImage): void {
    if (isGpuLost()) return;
    const gpu = getGpu();
    this.#syncEngineGpu(gpu);
    this.#uploadBoth(gpu, image, decoded);
    image.uploadedGeneration = gpu.generation;
  }

  /** The full-size texture plus the half-size variant the shader's
   * color-correction pass samples (production builds one per image). */
  #uploadBoth(gpu: Gpu, image: DecalImageImpl, decoded: DecodedImage): void {
    this.#engine.uploadImage(gpu.gl, image.key, decoded.width, decoded.height, decoded.rgba);
    const low = downscaleHalf(decoded);
    this.#engine.uploadImageLow(gpu.gl, image.key, low.width, low.height, low.rgba);
  }

  /** After a context loss the engine's GL objects are gone: drop the renderer
   * so the next call rebuilds it on the current context. */
  #syncEngineGpu(gpu: Gpu): void {
    if (this.#gpuGeneration === gpu.generation) return;
    this.#engine.resetGpu();
    this.#gpuGeneration = gpu.generation;
  }

  /** Re-decode from the retained source and upload — the recovery path. */
  async #reupload(image: DecalImageImpl, gpu: Gpu): Promise<void> {
    const source = image.source;
    if (!source) {
      throw new MockupError('disposed', 'image handle disposed during render', {
        detail: { cause: 'disposed' },
      });
    }
    const decoded = await decodeSource(this.#host, source, `image #${image.key}`);
    if (image.disposed) {
      throw new MockupError('disposed', 'image handle disposed during render', {
        detail: { cause: 'disposed' },
      });
    }
    this.#uploadBoth(gpu, image, decoded);
    image.uploadedGeneration = gpu.generation;
  }

  #checkSurface(value: Surface): SurfaceImpl {
    if (!(value instanceof SurfaceImpl) || value.owner !== this.#owner) {
      throw badRequest('surface must be a Surface handle created by this client');
    }
    if (value.disposed || value.shared.released || value.shared.data === null) {
      throw new MockupError('disposed', `surface ${value.url} has been disposed`, {
        detail: { cause: 'disposed' },
      });
    }
    return value;
  }

  #checkImage(value: DecalImage, decalId: string): DecalImageImpl {
    if (!(value instanceof DecalImageImpl) || value.owner !== this.#owner) {
      throw badRequest(`decal ${decalId}: image must be a DecalImage handle created by this client`);
    }
    if (value.disposed) {
      throw new MockupError('disposed', `decal ${decalId}: image handle has been disposed`, {
        detail: { cause: 'disposed' },
      });
    }
    return value;
  }

  // ---- render ---------------------------------------------------------------

  async render(request: RenderRequest): Promise<Render> {
    const started = now();
    const surfaceUrl = surfaceUrlOf(request);
    try {
      this.#assertLive();
      validateRenderRequest(request);
      const surface = this.#checkSurface(request.surface);
      const images = request.decals.map((d) => this.#checkImage(d.image, d.id));
      const photo = (surface.shared.data as SharedSurfaceData).photo;

      // Per-handle latest-wins coalescing: this call becomes the current
      // generation; every await checkpoint below rejects superseded calls.
      const generation = ++surface.renderGeneration;
      const checkCurrent = () => {
        if (this.#disposed) throw cancelled('client disposed');
        if (request.signal?.aborted) throw cancelled('render aborted');
        if (surface.disposed) throw cancelled('surface disposed during render');
        if (surface.renderGeneration !== generation) {
          throw cancelled('superseded by a newer render for this surface');
        }
        for (const image of images) {
          if (image.disposed) {
            throw new MockupError('disposed', 'a decal image was disposed during render', {
              detail: { cause: 'disposed' },
            });
          }
        }
      };

      // A usable context — waiting out a loss, or replacing the context, when
      // one is in progress. On the healthy path this is one microtask.
      const gpu = await ensureGpuUsable();
      checkCurrent();
      this.#syncEngineGpu(gpu);
      // Only after a loss: anything not resident in this generation goes
      // back up, re-decoded from what its handle retained.
      for (const image of [photo, ...images]) {
        if (image.uploadedGeneration !== gpu.generation) {
          await this.#reupload(image, gpu);
          checkCurrent();
        }
      }

      // Mockup-space extent, output size and decal assembly are pure
      // arithmetic — they live in render-plan.ts, where they are unit-tested
      // without a browser.
      const extent = resolveExtent(request.size, surface);
      // An explicit extent whose aspect differs from the surface stretches
      // the mockup and every decal on it. Legal (rendering into a differently
      // shaped box) but almost always a mistake, so dev mode says so.
      if (isDevMode() && request.size !== undefined && aspectDeviation(extent, surface) > 0.005) {
        devWarn(
          `render() extent ${extent.width}x${extent.height} has aspect ` +
            `${(extent.width / extent.height).toFixed(3)} but the surface is ` +
            `${surface.width}x${surface.height} (aspect ` +
            `${(surface.width / surface.height).toFixed(3)}); the mockup and every decal on it ` +
            'are stretched to fit. Omit size to inherit the surface size.',
        );
      }

      const pixelScale = request.pixelScale ?? 1;
      const plan = planOutput(extent, pixelScale, {
        deviceMaxOutputSize: queryDeviceMaxOutputSize(),
        maxOutputSize: this.#maxOutputBudget,
        maxOutputPixels: this.#maxPixelBudget,
      });
      const outW = plan.width;
      const outH = plan.height;
      // Capping silently would ship blurry exports and look like our bug;
      // the caller gets told which limit bound and what it actually got.
      if (plan.capped) {
        this.#emit({
          type: 'output-capped',
          surfaceUrl: surface.url,
          requested: plan.capped.requested,
          actual: { width: outW, height: outH },
          limit: plan.capped.limit,
          reason: plan.capped.reason,
        });
      }

      // Every transform stays in LOGICAL/element space and the device scale
      // lives ONLY in the output frame size: the vertex shader maps the [0,1]
      // mesh straight to clip space, so output resolution is decoupled from
      // the decal math.
      const surfaceSize: Size = { width: surface.width, height: surface.height };
      const renderJson = JSON.stringify({
        outW,
        outH,
        surfaceImgW: surface.width,
        surfaceImgH: surface.height,
        surfaceImage: photo.key,
        surfaceTransformJs: surfaceTransform(extent, surfaceSize),
        decals: request.decals.map((decal, i) => engineDecal(decal, images[i], images[i].key)),
        // Omitted for the default so pre-existing requests keep their JSON
        // byte-identical.
        ...(request.solver && request.solver !== 'classic' ? { solver: request.solver } : {}),
      });

      // The frame is drawn on the shared canvas's default framebuffer and
      // lifted off as a bitmap: no readback, no CPU copy.
      const { canvas, gl } = gpu;
      if (canvas.width !== outW || canvas.height !== outH) {
        canvas.width = outW;
        canvas.height = outH;
      }
      if (gl.isContextLost()) throw deviceLost();
      if (gl.drawingBufferWidth !== outW || gl.drawingBufferHeight !== outH) {
        // The browser clamped the drawing buffer: it could not give us the frame.
        throw new MockupError(
          'out-of-memory',
          `could not allocate a ${outW}x${outH} drawing buffer ` +
            `(got ${gl.drawingBufferWidth}x${gl.drawingBufferHeight})`,
          { detail: { requested: { width: outW, height: outH } } },
        );
      }

      const engineStart = now();
      const out = this.#engine.render(gl, surface.url, renderJson) as { boundsJson: string };
      const drawMs = now() - engineStart;
      // Lost mid-frame: GL calls silently became no-ops and the drawing
      // buffer is garbage. Say so instead of delivering a black frame.
      if (gl.isContextLost()) throw deviceLost();

      const deliverStart = now();
      const bitmap = canvas.transferToImageBitmap();
      try {
        checkCurrent();
      } catch (e) {
        bitmap.close();
        throw e;
      }

      const placements = JSON.parse(out.boundsJson) as (EnginePlacement | null)[];
      const bounds: Record<string, DecalBound | null> = {};
      request.decals.forEach((decal, index) => {
        // Placements are already in element/mockup space (transforms carry no
        // device scale), so no inverse-scale is applied.
        bounds[decal.id] = toDecalBound(placements[index] ?? null, 1);
      });

      const finished = now();
      const timings: RenderTimings = {
        totalMs: finished - started,
        solveMs: 0, // the engine does not split solve vs draw yet
        drawMs,
        deliverMs: finished - deliverStart,
      };
      this.#lastRender = timings;
      this.#emit({ type: 'render', surfaceUrl: surface.url, timings });
      if (this.#lostSinceLastRender) {
        // The first render after a loss made it through: healthy again.
        this.#lostSinceLastRender = false;
        this.#emit({ type: 'device-restored' });
      }
      return new RenderImpl(outW, outH, bounds, bitmap, `${outW}x${outH} of ${surface.url}`);
    } catch (e) {
      throw this.#emitError(toMockupError(e), surfaceUrl);
    }
  }

  // ---- introspection --------------------------------------------------------

  stats(): MockupStats {
    this.#assertLive();
    const bytes = this.#residentBytes();
    const stats: MockupStats = {
      surfaces: this.#surfaces.size,
      images: this.#images.size,
      bytes,
    };
    if (this.#lastRender) stats.lastRender = this.#lastRender;
    this.#checkResidentBudget(bytes);
    return stats;
  }

  /** RGBA-equivalent estimate: each distinct underlying surface once (its
   * photo plus four map textures at the solve size), every image handle.
   * Pictures carry their half-size variant too: ×1.25. */
  #residentBytes(): { surfaces: number; images: number } {
    const seen = new Set<SharedSurface>();
    let surfaces = 0;
    for (const handle of this.#surfaces) {
      const shared = handle.shared;
      if (seen.has(shared) || shared.data === null) continue;
      seen.add(shared);
      const d = shared.data;
      surfaces += d.width * d.height * 4 * 1.25 + 4 * d.solveW * d.solveH * 4;
    }
    let images = 0;
    for (const image of this.#images) images += image.width * image.height * 4 * 1.25;
    return { surfaces, images };
  }

  #checkResidentBudget(bytes = isDevMode() ? this.#residentBytes() : null): void {
    if (!bytes || this.#residentWarned || !isDevMode()) return;
    const total = bytes.surfaces + bytes.images;
    if (total <= RESIDENT_WARN_BYTES) return;
    this.#residentWarned = true;
    devWarn(
      `this client holds an estimated ${(total / (1024 * 1024)).toFixed(0)} MiB of resident textures ` +
        `(${this.#surfaces.size} surface handle(s), ${this.#images.size} image handle(s)). ` +
        'Residency is yours to manage: dispose handles you no longer show, or devices will start losing the GPU context.',
    );
  }

  limits(): MockupLimits {
    this.#assertLive();
    const deviceMaxOutputSize = queryDeviceMaxOutputSize();
    const limits: MockupLimits = {
      maxOutputSize: Math.min(this.#maxOutputBudget ?? deviceMaxOutputSize, deviceMaxOutputSize),
      deviceMaxOutputSize,
    };
    if (this.#maxPixelBudget !== undefined) limits.maxOutputPixels = this.#maxPixelBudget;
    return limits;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeLoss();
    // Handles first (they close bitmaps they own); engine calls are skipped
    // now that #disposed is set — free() below takes everything at once.
    for (const surface of [...this.#surfaces]) surface.dispose();
    for (const image of [...this.#images]) image.dispose();
    this.#shared.clear();
    try {
      this.#engine.free();
    } catch {
      // Already freed — free() is not idempotent on the wasm side.
    }
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
