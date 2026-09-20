/**
 * One render result.
 *
 * Take semantics are the point: the reference consumer had a double-owner
 * bug where a cache clear closed an ImageBitmap another caller was still
 * drawing. Here `takeImageBitmap()` consumes the result — every later call
 * throws kind:'disposed' — so that bug is not expressible. `drawTo` and
 * `encode` do not consume, since compositing and uploading are the common
 * cases and neither needs the bitmap to escape.
 *
 * The bitmap is the frame lifted straight off the SDK's canvas
 * (`transferToImageBitmap`): it never existed as CPU pixels, so `encode()`
 * draws it into a scratch canvas to produce the Blob.
 */
import { MockupError } from './errors.js';
import { watchForLeak, type LeakState } from './dev.js';
import type { DecalBound, EncodeOptions, Render } from '../types/mocksimple';

export class RenderImpl implements Render {
  readonly width: number;
  readonly height: number;
  readonly bounds: Readonly<Record<string, DecalBound | null>>;

  #bitmap: ImageBitmap | null;
  #gone: 'taken' | 'disposed' | null = null;
  /** Dev-mode leak detection; null when dev mode is off. */
  readonly #leak: LeakState | null;

  constructor(
    width: number,
    height: number,
    bounds: Record<string, DecalBound | null>,
    bitmap: ImageBitmap,
    label?: string,
  ) {
    this.width = width;
    this.height = height;
    this.bounds = Object.freeze(bounds);
    this.#bitmap = bitmap;
    this.#leak = watchForLeak(this, label ?? `render ${width}x${height}`);
  }

  #assertUsable(): ImageBitmap {
    if (this.#gone || !this.#bitmap) {
      throw new MockupError(
        'disposed',
        this.#gone === 'taken'
          ? 'render already consumed by takeImageBitmap()'
          : 'render already disposed',
        { detail: { cause: this.#gone ?? 'disposed' } },
      );
    }
    return this.#bitmap;
  }

  takeImageBitmap(): ImageBitmap {
    const bitmap = this.#assertUsable();
    this.#bitmap = null;
    this.#gone = 'taken';
    // Ownership passed to the caller — this render is not a leak.
    if (this.#leak) this.#leak.disposed = true;
    return bitmap;
  }

  drawTo(
    ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
    dx = 0,
    dy = 0,
    dw?: number,
    dh?: number,
  ): void {
    const bitmap = this.#assertUsable();
    ctx.drawImage(bitmap, dx, dy, dw ?? this.width, dh ?? this.height);
  }

  async encode(options?: EncodeOptions): Promise<Blob> {
    const bitmap = this.#assertUsable();
    const canvas = new OffscreenCanvas(this.width, this.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new MockupError('internal', 'OffscreenCanvas 2d context unavailable in encode()');
    // The frame is opaque (no alpha channel on the SDK's context), so the 2D
    // canvas round trip is lossless.
    ctx.drawImage(bitmap, 0, 0);
    return canvas.convertToBlob({ type: options?.type ?? 'image/png', quality: options?.quality });
  }

  dispose(): void {
    if (this.#gone) return; // idempotent; a taken render stays 'taken'
    this.#bitmap?.close();
    this.#bitmap = null;
    this.#gone = 'disposed';
    if (this.#leak) this.#leak.disposed = true;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
