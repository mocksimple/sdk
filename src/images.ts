/**
 * Pictures: what a handle keeps, how it is fetched, and how it becomes
 * straight-alpha RGBA for the engine.
 *
 * A `DecalImage` (and a surface's own photo) is uploaded to the GPU once.
 * What the handle RETAINS is the cheapest thing that can recreate the
 * texture after a context loss: the compressed bytes as fetched (a Blob), or
 * the caller's ImageBitmap by reference — never a decoded RGBA copy, which
 * would double the memory of every resident picture.
 *
 * The decode is pinned to `{premultiplyAlpha: 'none', colorSpaceConversion:
 * 'none'}` because the SDK owns those semantics — the reference
 * implementation's three different code paths each landed on a different
 * answer, and the renderer's blend assumes ours.
 */
import { cancelled, isAbortRejection, MockupError } from './errors.js';
import type { HostResponse, ImageSource, MockupHost } from '../types/mocksimple';

/** A decoded image as the engine consumes it. */
export interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/**
 * What a picture handle keeps for its lifetime. `owned` bitmaps were made by
 * us (from an ImageData) and are closed on dispose; caller-supplied bitmaps
 * are theirs to close.
 */
export type RetainedSource =
  | { kind: 'blob'; blob: Blob }
  | { kind: 'bitmap'; bitmap: ImageBitmap; owned: boolean };

export function isImageSource(value: unknown): value is ImageSource {
  if (typeof value === 'string') return value.length > 0;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
  if (typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap) return true;
  if (typeof ImageData !== 'undefined' && value instanceof ImageData) return true;
  return false;
}

/** Fetch a picture's bytes through the host (role 'image'). */
export async function fetchImageBlob(host: MockupHost, url: string): Promise<Blob> {
  let response: HostResponse;
  try {
    response = await host.fetch({
      url,
      method: 'GET',
      role: 'image',
      headers: {},
      signal: new AbortController().signal,
    });
  } catch (e) {
    // Any AbortError shape, not just a DOMException: the contract lets a
    // host construct its own (clause 2).
    if (isAbortRejection(e)) throw cancelled('image request aborted');
    // A MockupError from the host (or from dev-mode contract checking)
    // already says what went wrong — relabelling it as a transport
    // failure would bury the diagnosis.
    if (MockupError.is(e)) throw e;
    throw new MockupError('network', `image transport failure for ${url}`, {
      retryable: true,
      cause: e,
      detail: { url },
    });
  }
  if (response.status < 200 || response.status >= 300) {
    throw new MockupError('invalid-asset', `image request for ${url} returned HTTP ${response.status}`, {
      detail: { url, status: response.status },
    });
  }
  const mime = response.headers['content-type'] ?? response.headers['Content-Type'] ?? 'image/png';
  return new Blob([response.body as Uint8Array<ArrayBuffer>], { type: mime.split(';')[0].trim() });
}

/**
 * Turn a caller-supplied non-URL source into what the handle retains. An
 * ImageData is not kept: it becomes a bitmap of our own (straight alpha),
 * so the caller's buffer is free to be reused.
 */
export async function retainSource(source: Blob | ImageBitmap | ImageData): Promise<RetainedSource> {
  if (source instanceof Blob) return { kind: 'blob', blob: source };
  if (source instanceof ImageBitmap) return { kind: 'bitmap', bitmap: source, owned: false };
  const bitmap = await createImageBitmap(source, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  return { kind: 'bitmap', bitmap, owned: true };
}

/** Decode a retained source into RGBA the engine can upload. */
export async function decodeSource(
  host: MockupHost,
  source: RetainedSource,
  label: string,
): Promise<DecodedImage> {
  if (source.kind === 'bitmap') return readBitmap(source.bitmap, false);
  const { blob } = source;
  let bitmap: ImageBitmap;
  try {
    // Contract clause 7: unpremultiplied, no color-space conversion —
    // the SDK owns premultiplication semantics.
    bitmap = host.decodeImage
      ? await host.decodeImage(new Uint8Array(await blob.arrayBuffer()), blob.type || 'image/png')
      : await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch (e) {
    throw new MockupError('image-decode', `failed to decode image ${label}`, {
      cause: e,
      detail: { url: label },
    });
  }
  return readBitmap(bitmap, true);
}

/**
 * The half-size variant the color-correction pass samples
 * (`lowResMockupImage` / `lowResDecalImage`), built EXACTLY the way the
 * reference's `createLowResTexture` → `resizeImage` does: the straight-alpha
 * RGBA goes through `putImageData` on a same-size canvas, then `drawImage`
 * scales it onto a `floor(w/2) × floor(h/2)` canvas with
 * `imageSmoothingQuality = 'high'`, and `getImageData` reads it back. Same
 * operations in the same browser give the same bytes as the reference — the
 * parity harness pins that.
 */
export function downscaleHalf(image: DecodedImage): DecodedImage {
  const width = Math.max(1, Math.floor(image.width / 2));
  const height = Math.max(1, Math.floor(image.height / 2));
  const source = new OffscreenCanvas(image.width, image.height);
  const sourceCtx = source.getContext('2d');
  if (!sourceCtx) throw new MockupError('internal', 'OffscreenCanvas 2d context unavailable (downscale)');
  sourceCtx.putImageData(
    new ImageData(
      new Uint8ClampedArray(image.rgba.buffer, image.rgba.byteOffset, image.rgba.byteLength) as Uint8ClampedArray<ArrayBuffer>,
      image.width,
      image.height,
    ),
    0,
    0,
  );
  // No `willReadFrequently` here: it switches the canvas to the software
  // rasterizer, whose downscale filter differs from the accelerated one the
  // reference uses (measured: 12768 of 25600 bytes off by up to 3/255 on a
  // 160x160 noise image, which the color-correction pass then amplified to
  // a 46/255 frame difference). A plain 2D context matches byte for byte.
  const target = new OffscreenCanvas(width, height);
  const ctx = target.getContext('2d');
  if (!ctx) throw new MockupError('internal', 'OffscreenCanvas 2d context unavailable (downscale)');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height);
  return {
    width,
    height,
    rgba: new Uint8Array(data.data.buffer, data.data.byteOffset, data.data.byteLength),
  };
}

/** Bitmap → RGBA via a 2D OffscreenCanvas. `close` releases bitmaps we made. */
function readBitmap(bitmap: ImageBitmap, close: boolean): DecodedImage {
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new MockupError('internal', 'OffscreenCanvas 2d context unavailable');
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return {
      width: bitmap.width,
      height: bitmap.height,
      rgba: new Uint8Array(data.data.buffer, data.data.byteOffset, data.data.byteLength),
    };
  } finally {
    if (close) bitmap.close();
  }
}
