/**
 * The pure half of `render()`: everything that turns a `RenderRequest` plus
 * the surface's and images' dimensions into the numbers the engine is
 * handed, with no network, no GL, no wasm and no client state.
 *
 * It lives apart from the client for two reasons. It is where the fiddly
 * arithmetic is — extent defaulting, the two output budgets, the decal
 * transform composition, the bounds round-trip — and separating it lets all
 * of that be tested in plain Node (`test/render-plan.test.ts`), which is the
 * only automated check the shim's behavior has.
 *
 * Everything here is a function of its arguments. If a change needs client
 * state or I/O, it belongs in index.ts instead.
 */
import { badRequest } from './errors.js';
import type { DecalBound, DecalSpec, Point, RenderRequest, Size } from '../types/mocksimple';

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// ---------------------------------------------------------------------------
// Request validation
// ---------------------------------------------------------------------------

/**
 * Rejects malformed requests locally, before any work. TypeScript already
 * rules out the structural mistakes (a half-given `size`, a missing
 * transform); what remains is VALUES a JS caller can still get wrong —
 * NaN, zero, duplicate ids, a 5-element transform. Handle IDENTITY (is this
 * `surface` really one of ours, is it disposed) is the client's check: it
 * owns the handle classes.
 */
export function validateRenderRequest(request: RenderRequest): void {
  if (typeof request !== 'object' || request === null) {
    throw badRequest('render request must be an object');
  }
  if (typeof request.surface !== 'object' || request.surface === null) {
    throw badRequest('surface must be a Surface handle from prepareSurface()');
  }
  // `size` defaults to the surface's natural size (resolved once the surface
  // is prepared, in resolveExtent); only the VALUES are checkable here.
  if (request.size !== undefined) {
    if (typeof request.size !== 'object' || request.size === null) {
      throw badRequest('size must be an object {width, height}');
    }
    if (!isFiniteNumber(request.size.width) || request.size.width <= 0) {
      throw badRequest('size.width must be finite and > 0');
    }
    if (!isFiniteNumber(request.size.height) || request.size.height <= 0) {
      throw badRequest('size.height must be finite and > 0');
    }
  }
  if (
    request.pixelScale !== undefined &&
    (!isFiniteNumber(request.pixelScale) || request.pixelScale <= 0)
  ) {
    throw badRequest('pixelScale must be finite and > 0');
  }
  if (request.solver !== undefined && request.solver !== 'classic' && request.solver !== 'geodesic') {
    throw badRequest("solver must be 'classic' or 'geodesic'");
  }
  if (!Array.isArray(request.decals)) {
    throw badRequest('decals must be an array (pass [] for the bare surface)');
  }
  const seen = new Set<string>();
  for (const decal of request.decals) {
    if (typeof decal !== 'object' || decal === null || typeof decal.id !== 'string' || decal.id.length === 0) {
      throw badRequest('every decal needs a non-empty string id');
    }
    if (seen.has(decal.id)) throw badRequest(`duplicate decal id: ${decal.id}`);
    seen.add(decal.id);
    if (typeof decal.image !== 'object' || decal.image === null) {
      throw badRequest(`decal ${decal.id}: image must be a DecalImage handle from loadImage()`);
    }
    if (
      !Array.isArray(decal.transform) ||
      decal.transform.length !== 6 ||
      !decal.transform.every(isFiniteNumber)
    ) {
      throw badRequest(
        `decal ${decal.id}: transform must be 6 finite numbers in canvas setTransform order [a, b, c, d, e, f]`,
      );
    }
    if (decal.crop !== undefined) {
      if (
        !Array.isArray(decal.crop) ||
        decal.crop.length !== 4 ||
        !decal.crop.every(isFiniteNumber) ||
        decal.crop[2] <= 0 ||
        decal.crop[3] <= 0
      ) {
        throw badRequest(`decal ${decal.id}: crop must be [x, y, w, h], finite, with w/h > 0`);
      }
    }
    if (
      decal.shading !== undefined &&
      (!isFiniteNumber(decal.shading) || decal.shading < 0 || decal.shading > 1)
    ) {
      throw badRequest(`decal ${decal.id}: shading must be a finite number between 0 and 1`);
    }
  }
}

// ---------------------------------------------------------------------------
// Mockup-space extent
// ---------------------------------------------------------------------------

/**
 * The coordinate system decal transforms and bounds live in: what the caller
 * asked for, or the surface's own pixels. Defaulting cannot happen at
 * validation time because the photo's dimensions are only known once the
 * surface is prepared.
 */
export function resolveExtent(requested: Size | undefined, surface: Size): Size {
  return {
    width: requested?.width ?? surface.width,
    height: requested?.height ?? surface.height,
  };
}

/**
 * How far an explicit extent's aspect ratio departs from the surface's, as a
 * fraction. Anything non-trivial stretches the mockup and every decal on it
 * — legal, but almost always a mistake, so dev mode warns on it.
 */
export function aspectDeviation(extent: Size, surface: Size): number {
  const asked = extent.width / extent.height;
  const natural = surface.width / surface.height;
  return Math.abs(asked - natural) / natural;
}

/**
 * Photo pixels → mockup (element) space, canvas order. At the default extent
 * this is the identity.
 */
export function surfaceTransform(extent: Size, surface: Size): [number, number, number, number, number, number] {
  return [extent.width / surface.width, 0, 0, extent.height / surface.height, 0, 0];
}

// ---------------------------------------------------------------------------
// Output size
// ---------------------------------------------------------------------------

export interface OutputBudgets {
  /** GPU texture-dimension limit: an absolute ceiling. */
  deviceMaxOutputSize: number;
  /** Caller's long-side budget, if any. Can only lower the ceiling. */
  maxOutputSize?: number;
  /** Caller's area budget, if any. Not applied unless set. */
  maxOutputPixels?: number;
}

export interface OutputPlan {
  /** Final bitmap size in device pixels. */
  width: number;
  height: number;
  /** Effective mockup-unit → device-pixel factor after any downscale. */
  scale: number;
  /** Present only when the request had to be scaled down. */
  capped?: {
    requested: { width: number; height: number };
    limit: number;
    reason: 'max-output-pixels' | 'max-output-size' | 'device-limit';
  };
}

/**
 * `ceil(extent × pixelScale)`, downscaled uniformly only when it cannot be
 * rendered (the GPU's texture-dimension limit) or when the caller set a
 * budget. Nothing is capped for being merely expensive: a big output that
 * takes a while beats one we refused.
 *
 * Two limits because they bound different things. The long side is a
 * feasibility limit — a texture dimension cannot exceed the GPU's maximum.
 * Area is an affordability limit — time and memory track `width × height`,
 * so a long-side rule alone lets 4096×4096 through at four times the cost of
 * 4096×1024. Area is quadratic in the scale factor, hence the square root.
 *
 * Rounding: each side is rounded UP, so the long-side limit is hit exactly
 * (its factor is derived from that very dimension) while an area budget can
 * be exceeded by the rounding of the other side — under 0.1% in practice.
 * The area budget is a cost budget, not an allocation limit, so it is not
 * worth biasing the arithmetic to chase; the hard limit is already exact.
 */
export function planOutput(extent: Size, pixelScale: number, budgets: OutputBudgets): OutputPlan {
  const { deviceMaxOutputSize, maxOutputSize, maxOutputPixels } = budgets;
  const sideLimit = Math.min(maxOutputSize ?? deviceMaxOutputSize, deviceMaxOutputSize);
  const longer = Math.max(extent.width, extent.height) * pixelScale;
  const sideFactor = longer > sideLimit ? sideLimit / longer : 1;

  let areaFactor = 1;
  if (maxOutputPixels !== undefined) {
    const area = extent.width * pixelScale * (extent.height * pixelScale);
    if (area > maxOutputPixels) areaFactor = Math.sqrt(maxOutputPixels / area);
  }

  const factor = Math.min(sideFactor, areaFactor);
  const scale = pixelScale * factor;
  const plan: OutputPlan = {
    width: Math.ceil(extent.width * scale),
    height: Math.ceil(extent.height * scale),
    scale,
  };
  if (factor < 1) {
    const areaBound = areaFactor < sideFactor;
    plan.capped = {
      requested: {
        width: Math.ceil(extent.width * pixelScale),
        height: Math.ceil(extent.height * pixelScale),
      },
      limit: areaBound ? (maxOutputPixels as number) : sideLimit,
      reason: areaBound
        ? 'max-output-pixels'
        : maxOutputSize !== undefined && maxOutputSize <= deviceMaxOutputSize
          ? 'max-output-size'
          : 'device-limit',
    };
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Decal assembly
// ---------------------------------------------------------------------------

/** One decal as the wasm Engine's render JSON declares it (engine.rs). */
export interface EngineDecalParam {
  /** Resident texture key of the decal's picture. */
  image: number;
  bbox: { x: number; y: number; w: number; h: number };
  size: { w: number; h: number };
  transformJs: [number, number, number, number, number, number];
  adjust?: { brightness: number; contrast: number; saturate: number; hue: number };
  /** Surface-lighting strength, 0–1; omitted at the default 1. */
  shading?: number;
}

/**
 * Public decal → engine decal. `image` is the picture's natural size and
 * `key` its resident texture key.
 *
 * Public and engine decal space are both the image's natural pixels, so the
 * only thing to compose is the crop origin: `T_public ∘ T(-cropX, -cropY)`.
 * With no crop that is `T_public` verbatim. No device scale enters here — the
 * output resolution lives only in the frame size.
 *
 * A neutral or absent `adjust` is omitted rather than normalized, so the
 * engine JSON stays byte-identical to requests written before the field
 * existed; `shading` at its default of 1 is omitted for the same reason.
 */
export function engineDecal(decal: DecalSpec, image: Size, key: number): EngineDecalParam {
  const crop = decal.crop ?? [0, 0, image.width, image.height];
  const [a, b, c, d, e, f] = decal.transform;
  const tx = -crop[0];
  const ty = -crop[1];
  const adj = decal.adjust;
  const adjust =
    adj &&
    ((adj.brightness ?? 1) !== 1 ||
      (adj.contrast ?? 1) !== 1 ||
      (adj.saturate ?? 1) !== 1 ||
      (adj.hue ?? 0) !== 0)
      ? {
          brightness: adj.brightness ?? 1,
          contrast: adj.contrast ?? 1,
          saturate: adj.saturate ?? 1,
          hue: adj.hue ?? 0,
        }
      : undefined;
  const shading = decal.shading !== undefined && decal.shading !== 1 ? decal.shading : undefined;
  return {
    image: key,
    bbox: { x: crop[0], y: crop[1], w: crop[2], h: crop[3] },
    size: { w: image.width, h: image.height },
    transformJs: [a, b, c, d, a * tx + c * ty + e, b * tx + d * ty + f],
    ...(adjust ? { adjust } : {}),
    ...(shading !== undefined ? { shading } : {}),
  };
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Where the engine says a decal landed (engine.rs `boundsJson`). */
export interface EnginePlacement {
  bbox: { x: number; y: number; w: number; h: number };
  transformJs: [number, number, number, number, number, number];
}

/**
 * Engine placement → public `DecalBound`, divided by `scale` back into
 * mockup space. `quad` is the ground truth: the placement transform applied
 * to the engine bbox corners. The oriented-box fields use the same corner as
 * `(x, y)`, `|column|` scales for `w`/`h`, and `atan2(b, a)` degrees
 * clockwise (y-down) for rotation, reconstructing `quad` exactly for
 * mirror/skew-free placements (API.md §3.7).
 */
export function toDecalBound(placement: EnginePlacement | null, scale: number): DecalBound | null {
  if (!placement) return null;
  const [a, b, c, d, e, f] = placement.transformJs;
  const inv = 1 / scale;
  const apply = (x: number, y: number): Point => ({
    x: (a * x + c * y + e) * inv,
    y: (b * x + d * y + f) * inv,
  });
  const { x: bx, y: by, w: bw, h: bh } = placement.bbox;
  const p0 = apply(bx, by);
  const quad: [Point, Point, Point, Point] = [
    p0,
    apply(bx + bw, by),
    apply(bx + bw, by + bh),
    apply(bx, by + bh),
  ];
  return {
    quad,
    x: p0.x,
    y: p0.y,
    w: bw * Math.hypot(a, b) * inv,
    h: bh * Math.hypot(c, d) * inv,
    rotation: (Math.atan2(b, a) * 180) / Math.PI,
  };
}
