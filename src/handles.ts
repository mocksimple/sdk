/**
 * The caller-owned resource handles: `Surface` and `DecalImage`.
 *
 * A handle is the unit of residency. It exists from the moment its
 * `prepareSurface()` / `loadImage()` resolves until `dispose()`, and while
 * it exists its GPU texture (and, for surfaces, the engine's CPU state) is
 * guaranteed resident — the SDK evicts nothing on its own. The client wires
 * `onDispose` so bookkeeping (refcounts, engine release) happens in one
 * place; the handle itself only knows how to make itself unusable.
 */
import { watchForLeak, type LeakState } from './dev.js';
import type { RetainedSource } from './images.js';
import type { DecalImage, Surface } from '../types/mocksimple';

/** Engine texture keys: page-unique, never 0 (reserved by the engine). */
let nextImageKey = 1;
export function allocateImageKey(): number {
  return nextImageKey++;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export class DecalImageImpl implements DecalImage {
  readonly width: number;
  readonly height: number;
  /** Engine texture key. */
  readonly key: number;
  /** Identity of the creating client — handles never cross clients. */
  readonly owner: object;
  /** What recreates the texture after a GPU reset; null once disposed. */
  source: RetainedSource | null;
  /** GPU generation the texture was uploaded in; -1 = not resident. */
  uploadedGeneration = -1;
  disposed = false;
  onDispose: (() => void) | null = null;
  readonly #leak: LeakState | null;

  constructor(key: number, width: number, height: number, source: RetainedSource, owner: object, label: string) {
    this.key = key;
    this.width = width;
    this.height = height;
    this.source = source;
    this.owner = owner;
    this.#leak = watchForLeak(this, label);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.#leak) this.#leak.disposed = true;
    const source = this.source;
    this.source = null;
    if (source?.kind === 'bitmap' && source.owned) source.bitmap.close();
    this.onDispose?.();
    this.onDispose = null;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/** What a prepared surface amounts to once its pipeline has resolved. */
export interface SharedSurfaceData {
  /** Photo natural size — the public `Surface.width/height`. */
  width: number;
  height: number;
  /** Engine solve size (map dims) — sizes the stats estimate. */
  solveW: number;
  solveH: number;
  solvers: readonly ('classic' | 'geodesic')[];
  /** The photo, resident like any image (an internal handle). */
  photo: DecalImageImpl;
}

/**
 * The underlying surface every handle to one URL shares within a client.
 * Released when no handle holds it AND no prepare call is still waiting to
 * become one AND the pipeline has settled — so an aborted prepare never
 * leaves anything behind, and a React effect that runs twice costs one
 * build.
 */
export interface SharedSurface {
  readonly url: string;
  pipeline: Promise<SharedSurfaceData>;
  /** Set when the pipeline resolves. */
  data: SharedSurfaceData | null;
  /** Live handles. */
  refs: number;
  /** In-flight prepare calls not yet turned into handles. */
  waiters: number;
  released: boolean;
}

export class SurfaceImpl implements Surface {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly solvers: readonly ('classic' | 'geodesic')[];
  readonly owner: object;
  readonly shared: SharedSurface;
  /** Latest-wins counter for renders on THIS handle. */
  renderGeneration = 0;
  disposed = false;
  onDispose: (() => void) | null = null;
  readonly #leak: LeakState | null;

  constructor(shared: SharedSurface, data: SharedSurfaceData, owner: object) {
    this.url = shared.url;
    this.width = data.width;
    this.height = data.height;
    this.solvers = data.solvers;
    this.owner = owner;
    this.shared = shared;
    this.#leak = watchForLeak(this, `surface ${shared.url}`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.#leak) this.#leak.disposed = true;
    this.onDispose?.();
    this.onDispose = null;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
