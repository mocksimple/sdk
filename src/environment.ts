/**
 * Environment probing and the SDK's single hidden rendering context —
 * including what happens when the browser takes that context away.
 *
 * The contract promises that no graphics handle ever crosses the public API,
 * so the WebGL2 context lives here: one OffscreenCanvas, created lazily,
 * shared by every client on the page (browsers cap contexts at 8–16, and a
 * client per widget is a documented pattern), never handed out.
 *
 * Context loss (GPU process crash, a backgrounded tab on a memory-starved
 * phone) is a normal event, not an error:
 *
 * 1. `webglcontextlost` — `preventDefault()` so the browser is allowed to
 *    restore THIS context, mark it lost, tell every client (they emit
 *    {type:'device-lost'}).
 * 2. A render that arrives while lost waits, bounded, for
 *    `webglcontextrestored`. The browser restoring the same context is the
 *    cheap path: nothing but GPU objects need rebuilding.
 * 3. If the restore never comes, a canvas is single-use: a lost context can
 *    not be re-created on it. We drop it and make a fresh OffscreenCanvas
 *    with a fresh context. If even that fails, WebGL is gone for this page
 *    (blocklisted after repeated crashes) — `unsupported`, suggest a reload.
 *
 * Either way the survivors are told apart by `generation`: a client whose
 * engine was built for an older generation resets its GPU state and
 * re-uploads what the next frame needs. Nothing here depends on the events
 * alone — `isContextLost()` is polled at render time too, because some
 * browsers lose OffscreenCanvas contexts silently.
 */
import { MockupError } from './errors.js';

/** The graphics-spec floor for MAX_TEXTURE_SIZE (OpenGL ES 3.0 / WebGL2). */
const MIN_GUARANTEED_OUTPUT_SIZE = 2048;

/** How long a render waits for the browser to restore a lost context before
 * giving up on it and creating a fresh one. Chrome's GPU process restarts in
 * well under a second; iOS Safari may never fire the event. */
const RESTORE_WAIT_MS = 2000;

/** Recoveries tolerated per window. Beyond this the device is losing the
 * context faster than we can rebuild (memory pressure): stop thrashing and
 * report `unsupported` so the app can shed resident handles or reload. */
const MAX_RECOVERIES_PER_WINDOW = 3;
const RECOVERY_WINDOW_MS = 60_000;

/**
 * Attributes chosen so the canvas path is pixel-identical to rendering into
 * the engine's RGB texture attachment: no alpha channel (alpha reads 255,
 * and blend results are not disturbed by destination alpha), no
 * multisampling (the FBO path had none), nothing we do not use. The frame is
 * lifted off within the same task, so the drawing buffer need not persist.
 */
const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
};

// ---------------------------------------------------------------------------
// Capability gate
// ---------------------------------------------------------------------------

interface SupportProbe {
  supported: boolean;
  missing?: 'webassembly' | 'webgl2' | 'offscreen-canvas';
}

let supportProbe: SupportProbe | null = null;

export function probeSupport(): SupportProbe {
  if (supportProbe) return supportProbe;
  const hasWasm =
    typeof WebAssembly === 'object' &&
    WebAssembly !== null &&
    typeof WebAssembly.instantiate === 'function';
  if (!hasWasm) {
    supportProbe = { supported: false, missing: 'webassembly' };
    return supportProbe;
  }
  // The hidden context, image decoding and Render.encode() all live on an
  // OffscreenCanvas. Gating here keeps the failure at the capability check,
  // where the contract says it belongs. This is what sets the browser floor
  // at Safari 16.4 / Firefox 105 (Chrome has had it since 69).
  if (typeof OffscreenCanvas === 'undefined') {
    supportProbe = { supported: false, missing: 'offscreen-canvas' };
    return supportProbe;
  }
  // The probe IS the shared context: a successful probe leaves nothing to
  // create later, and a page never holds a throwaway context.
  try {
    getGpu();
    supportProbe = { supported: true };
  } catch {
    supportProbe = { supported: false, missing: 'webgl2' };
  }
  return supportProbe;
}

/** Cheap capability gate: WebAssembly + OffscreenCanvas + WebGL2. Computed once and cached. */
export function isSupported(): boolean {
  return probeSupport().supported;
}

// ---------------------------------------------------------------------------
// The hidden shared rendering context
// ---------------------------------------------------------------------------

/** What a client needs from the GPU for one operation. */
export interface Gpu {
  readonly canvas: OffscreenCanvas;
  readonly gl: WebGL2RenderingContext;
  /**
   * Bumped whenever GPU state must be rebuilt from scratch: after a restore
   * (same context, all objects gone) and for a fresh context. Clients
   * compare it with the generation their engine last drew on.
   */
  readonly generation: number;
}

interface GpuState {
  canvas: OffscreenCanvas;
  gl: WebGL2RenderingContext;
  generation: number;
  lost: boolean;
  /** Resolvers of renders waiting for `webglcontextrestored`. */
  restoreWaiters: Array<(restored: boolean) => void>;
}

let gpu: GpuState | null = null;
let nextGeneration = 1;
/** Timestamps of recent recoveries (restores and fresh contexts), for the cap. */
const recoveries: number[] = [];
const lossListeners = new Set<() => void>();

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function createGpu(): GpuState {
  const canvas = new OffscreenCanvas(1, 1);
  const gl = canvas.getContext('webgl2', CONTEXT_ATTRIBUTES);
  if (!gl) {
    throw new MockupError(
      'unsupported',
      'WebGL2 context creation failed (is hardware acceleration disabled?)',
      { detail: { capability: 'webgl2' } },
    );
  }
  const state: GpuState = {
    canvas,
    gl,
    generation: nextGeneration++,
    lost: false,
    restoreWaiters: [],
  };
  // Both the WebGL-specific and the generic canvas event names: browsers
  // differ in which they dispatch on an OffscreenCanvas.
  const onLost = (event: Event) => {
    // Without preventDefault the browser never restores this context.
    event.preventDefault();
    markLost(state);
  };
  const onRestored = () => {
    if (gpu !== state || !state.lost) return; // superseded by a fresh context, or noise
    state.lost = false;
    state.generation = nextGeneration++;
    recoveries.push(nowMs());
    const waiters = state.restoreWaiters.splice(0);
    for (const resolve of waiters) resolve(true);
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('contextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  canvas.addEventListener('contextrestored', onRestored);
  return state;
}

function markLost(state: GpuState): void {
  if (state.lost) return;
  state.lost = true;
  for (const listener of lossListeners) {
    try {
      listener();
    } catch {
      // Listeners are event sinks; they never break recovery.
    }
  }
}

/** The shared context, created on first use. Does NOT check for loss — use
 * `ensureGpuUsable()` before drawing. Throws kind:'unsupported' when WebGL2
 * cannot be created at all. */
export function getGpu(): Gpu {
  if (!gpu) gpu = createGpu();
  return gpu;
}

/** Whether the shared context is currently lost — the backing state for
 * `MockupClient.probe()`. Reported without creating a context: a client
 * that never rendered has nothing to lose. */
export function isGpuLost(): boolean {
  if (!gpu) return false;
  if (!gpu.lost && gpu.gl.isContextLost()) markLost(gpu);
  return gpu.lost;
}

/** Subscribe to context-loss notifications (one call per loss episode).
 * Returns the unsubscribe function. */
export function onDeviceLost(listener: () => void): () => void {
  lossListeners.add(listener);
  return () => {
    lossListeners.delete(listener);
  };
}

function waitForRestore(state: GpuState, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const index = state.restoreWaiters.indexOf(settle);
      if (index >= 0) state.restoreWaiters.splice(index, 1);
      resolve(false);
    }, ms);
    const settle = (restored: boolean) => {
      clearTimeout(timer);
      resolve(restored);
    };
    state.restoreWaiters.push(settle);
  });
}

/** Too many recoveries in the window: the device keeps taking the context
 * away. Recovering again would only thrash. */
function recoveryBudgetExceeded(): boolean {
  const cutoff = nowMs() - RECOVERY_WINDOW_MS;
  while (recoveries.length > 0 && recoveries[0] < cutoff) recoveries.shift();
  return recoveries.length > MAX_RECOVERIES_PER_WINDOW;
}

function contextGone(): MockupError {
  return new MockupError(
    'unsupported',
    'the WebGL context was lost and could not be recovered — reload the page, or hold fewer surfaces and images',
    { detail: { capability: 'webgl2', reason: 'context-lost' } },
  );
}

/**
 * A usable context, recovering from loss if necessary: wait (bounded) for the
 * browser to restore the current one, otherwise replace it. Resolves quickly
 * on the healthy path (one microtask). Throws kind:'unsupported' with
 * `detail.reason: 'context-lost'` when recovery is impossible or has been
 * needed too often.
 */
export async function ensureGpuUsable(): Promise<Gpu> {
  const state = getGpu() as GpuState;
  // Polling covers browsers that lose the context without dispatching the event.
  if (!state.lost && state.gl.isContextLost()) markLost(state);
  if (!state.lost) return state;

  const restored = await waitForRestore(state, RESTORE_WAIT_MS);
  if (gpu !== state) {
    // Another caller already replaced the context while we waited.
    return ensureGpuUsable();
  }
  if (restored && !state.lost) {
    if (recoveryBudgetExceeded()) throw contextGone();
    return state;
  }
  // The browser will not give this context back. A canvas has one context
  // for life, so the only way forward is a new canvas.
  if (recoveryBudgetExceeded()) throw contextGone();
  let fresh: GpuState;
  try {
    fresh = createGpu();
  } catch (e) {
    throw new MockupError(
      'unsupported',
      'the WebGL context was lost and a new one could not be created — reload the page',
      { detail: { capability: 'webgl2', reason: 'context-lost' }, cause: e },
    );
  }
  recoveries.push(nowMs());
  const waiters = state.restoreWaiters.splice(0);
  for (const resolve of waiters) resolve(false);
  gpu = fresh;
  return fresh;
}

// ---------------------------------------------------------------------------
// Device limits
// ---------------------------------------------------------------------------

let deviceMaxOutput: number | null = null;

/**
 * The GPU's maximum output dimension — the hard ceiling on a render, since a
 * frame is drawn into the canvas's drawing buffer (and, on the readback path,
 * a texture-backed FBO): the smallest of the texture, renderbuffer and
 * viewport limits. Queried once. A bogus or missing driver value falls back
 * to the spec floor rather than producing a ceiling below what every WebGL2
 * device must support.
 */
export function queryDeviceMaxOutputSize(): number {
  if (deviceMaxOutput !== null) return deviceMaxOutput;
  let value = 0;
  let lost = true;
  try {
    const gl = getGpu().gl;
    lost = gl.isContextLost();
    const texture = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
    const renderbuffer = Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    const viewport = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array | null;
    const viewportMin = viewport ? Math.min(Number(viewport[0]), Number(viewport[1])) : Infinity;
    value = Math.min(texture, renderbuffer, viewportMin);
  } catch {
    value = 0;
  }
  const result =
    Number.isFinite(value) && value >= MIN_GUARANTEED_OUTPUT_SIZE
      ? Math.floor(value)
      : MIN_GUARANTEED_OUTPUT_SIZE;
  // A lost context answers null to every query; do not cache the floor then.
  if (!lost) deviceMaxOutput = result;
  return result;
}
