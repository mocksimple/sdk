/**
 * Runtime tests for the pure half of render() — the arithmetic that decides
 * what the engine is asked to draw.
 *
 * These run in plain Node (`node --test`, type-stripped): no browser, no
 * wasm, no GL. They are the shim's only executable check, so the assertions
 * here are the ones that used to be verified by hand in a browser.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  aspectDeviation,
  engineDecal,
  planOutput,
  resolveExtent,
  surfaceTransform,
  toDecalBound,
  validateRenderRequest,
} from '../dist/render-plan.js';
import { MockupError } from '../dist/errors.js';
import type { DecalImage, DecalSpec, RenderRequest, Surface } from '../types/mocksimple';

const photo = { width: 1772, height: 2048 };

/** Handle stand-ins: validation only checks that these are objects — identity
 * (is it really ours, is it disposed) is the client's job, and needs a
 * browser. */
const fakeSurface = { url: 'https://x/p.jpg', ...photo, solvers: ['classic'] } as unknown as Surface;
const fakeImage = { width: 1000, height: 500 } as unknown as DecalImage;

/** Assert that `fn` rejects with kind:'bad-request' and a message matching. */
function rejects(fn: () => void, match: RegExp): void {
  assert.throws(fn, (e: unknown) => {
    assert.ok(MockupError.is(e, 'bad-request'), `expected bad-request, got ${String(e)}`);
    assert.match((e as MockupError).message, match);
    return true;
  });
}

const baseRequest = (over: Partial<RenderRequest> = {}): RenderRequest =>
  ({ surface: fakeSurface, decals: [], ...over }) as RenderRequest;

describe('resolveExtent', () => {
  it('defaults to the surface size, so decal transforms are photo pixels', () => {
    assert.deepEqual(resolveExtent(undefined, photo), photo);
  });

  it('takes an explicit extent verbatim', () => {
    assert.deepEqual(resolveExtent({ width: 1, height: 1 }, photo), { width: 1, height: 1 });
  });
});

describe('aspectDeviation', () => {
  it('is zero at the surface aspect', () => {
    assert.equal(aspectDeviation(photo, photo), 0);
    assert.equal(aspectDeviation({ width: 886, height: 1024 }, photo), 0);
  });

  it('measures the departure that stretches the mockup', () => {
    // A square box on a 1772x2048 photo: 1 / 0.8652 - 1 ≈ 0.1557
    assert.ok(Math.abs(aspectDeviation({ width: 800, height: 800 }, photo) - 0.1557) < 1e-3);
  });
});

describe('surfaceTransform', () => {
  it('is the identity at the default extent', () => {
    assert.deepEqual(surfaceTransform(photo, photo), [1, 0, 0, 1, 0, 0]);
  });

  it('scales each axis independently for a differently shaped box', () => {
    assert.deepEqual(surfaceTransform({ width: 886, height: 4096 }, photo), [0.5, 0, 0, 2, 0, 0]);
  });
});

describe('planOutput', () => {
  const device = { deviceMaxOutputSize: 16384 };

  it('renders at the photo resolution with no budgets and scale 1', () => {
    const p = planOutput(photo, 1, device);
    assert.deepEqual([p.width, p.height], [1772, 2048]);
    assert.equal(p.capped, undefined);
  });

  it('does not cap an expensive-but-renderable request', () => {
    // 2x of this photo is 14.5 MP. Slow is not a reason to refuse.
    const p = planOutput(photo, 2, device);
    assert.deepEqual([p.width, p.height], [3544, 4096]);
    assert.equal(p.capped, undefined);
  });

  it('caps at the GPU limit and says so', () => {
    const p = planOutput(photo, 16, device);
    assert.equal(Math.max(p.width, p.height), 16384);
    assert.equal(p.capped?.reason, 'device-limit');
    assert.equal(p.capped?.limit, 16384);
    assert.deepEqual(p.capped?.requested, { width: 28352, height: 32768 });
  });

  it("attributes the cap to the caller's budget when that is what bound", () => {
    const p = planOutput(photo, 1, { ...device, maxOutputSize: 1000 });
    assert.deepEqual([p.width, p.height], [866, 1000]);
    assert.equal(p.capped?.reason, 'max-output-size');
  });

  it('applies an area budget only when set, and reports it as the reason', () => {
    assert.equal(planOutput(photo, 2, device).capped, undefined);
    const p = planOutput(photo, 2, { ...device, maxOutputPixels: 4_194_304 });
    assert.equal(p.capped?.reason, 'max-output-pixels');
    assert.ok((p.width - 1) * (p.height - 1) <= 4_194_304, 'fits but for rounding');
    assert.ok(p.width * p.height > 4_194_304 * 0.99, 'does not undershoot');
  });

  it('overshoots an area budget by at most one pixel per side, at any scale', () => {
    // The contract states the bound as one pixel per side, i.e. relatively
    // about (1/width + 1/height). That is ~0.065% for a multi-megapixel
    // budget but ~1% for a small one, so a flat "under 0.1%" claim would be
    // wrong at the small end — 40 000 px lands 0.98% over.
    for (const budget of [40_000, 250_000, 1_000_000, 4_194_304]) {
      const p = planOutput(photo, 2, { ...device, maxOutputPixels: budget });
      const bound = (p.width - 1) * (p.height - 1);
      assert.ok(bound <= budget, `${budget}: within budget but for rounding`);
      const overshoot = (p.width * p.height) / budget - 1;
      const predicted = 1 / p.width + 1 / p.height + 1 / (p.width * p.height);
      assert.ok(overshoot <= predicted, `${budget}: overshoot ${overshoot} <= ${predicted}`);
    }
  });

  it('leaves a wide panorama alone that a long-side rule would have shrunk', () => {
    // 4000x1000 is 4 MP — affordable. A 2048 long-side cap would have cut it
    // to 2048x512, a quarter of the pixels, for no reason.
    const p = planOutput({ width: 4000, height: 1000 }, 1, device);
    assert.deepEqual([p.width, p.height], [4000, 1000]);
    assert.equal(p.capped, undefined);
  });

  it('takes the tighter of the two budgets', () => {
    const both = { ...device, maxOutputSize: 4096, maxOutputPixels: 1_000_000 };
    const p = planOutput(photo, 4, both);
    assert.equal(p.capped?.reason, 'max-output-pixels'); // area binds first here
    assert.ok(Math.max(p.width, p.height) <= 4096);
  });

  it('never lets a budget exceed the device', () => {
    const p = planOutput(photo, 100, { deviceMaxOutputSize: 4096, maxOutputSize: 99999 });
    assert.equal(Math.max(p.width, p.height), 4096);
    assert.equal(p.capped?.reason, 'device-limit');
  });

  it('preserves the aspect ratio through any downscale', () => {
    const p = planOutput(photo, 8, device);
    const before = photo.width / photo.height;
    const after = p.width / p.height;
    assert.ok(Math.abs(before - after) / before < 1e-3);
  });
});

describe('engineDecal', () => {
  const image = { width: 1000, height: 500 };
  const KEY = 7;
  // 0.2 mockup units per image pixel — a 1000x500 design drawn 200x100.
  const decal = (over: Partial<DecalSpec> = {}): DecalSpec =>
    ({
      id: 'd',
      image: fakeImage,
      transform: [0.2, 0, 0, 0.2, 50, 60],
      ...over,
    }) as DecalSpec;

  it('passes the public transform straight through when there is no crop', () => {
    const e = engineDecal(decal(), image, KEY);
    assert.deepEqual(e.transformJs, [0.2, 0, 0, 0.2, 50, 60]);
    assert.deepEqual(e.bbox, { x: 0, y: 0, w: 1000, h: 500 });
    assert.deepEqual(e.size, { w: 1000, h: 500 });
  });

  it('references the picture by its resident texture key, never by pixels', () => {
    const e = engineDecal(decal(), image, KEY);
    assert.equal(e.image, KEY);
    assert.ok(!('imgW' in e) && !('imgH' in e), 'no per-frame image payload');
  });

  it('shifts local space to the crop origin without resizing the decal', () => {
    // Show only the right half. The scale is untouched; the decal moves by the
    // crop origin: e = 0.2*(-500) + 50 = -50.
    const e = engineDecal(decal({ crop: [500, 0, 500, 500] }), image, KEY);
    assert.deepEqual(e.bbox, { x: 500, y: 0, w: 500, h: 500 });
    assert.deepEqual(e.transformJs, [0.2, 0, 0, 0.2, -50, 60]);
  });

  it('leaves a decal cropped from the right or bottom exactly where it was', () => {
    const e = engineDecal(decal({ crop: [0, 0, 400, 200] }), image, KEY);
    assert.deepEqual(e.transformJs, [0.2, 0, 0, 0.2, 50, 60]);
  });

  it('keeps rotation and skew in canvas order through the composition', () => {
    const e = engineDecal(decal({ transform: [0, 0.2, -0.2, 0, 0, 0] }), image, KEY);
    assert.deepEqual(e.transformJs, [0, 0.2, -0.2, 0, 0, 0]);
  });

  it('omits a neutral adjust so the engine JSON stays byte-identical', () => {
    assert.equal(engineDecal(decal(), image, KEY).adjust, undefined);
    assert.equal(
      engineDecal(decal({ adjust: { brightness: 1, contrast: 1, saturate: 1, hue: 0 } }), image, KEY)
        .adjust,
      undefined,
    );
    assert.equal(engineDecal(decal({ adjust: {} }), image, KEY).adjust, undefined);
  });

  it('fills in every neutral field once any one of them is set', () => {
    const e = engineDecal(decal({ adjust: { saturate: 0 } }), image, KEY);
    assert.deepEqual(e.adjust, { brightness: 1, contrast: 1, saturate: 0, hue: 0 });
  });

  it('omits the default shading so the engine JSON stays byte-identical', () => {
    assert.ok(!('shading' in engineDecal(decal(), image, KEY)));
    assert.ok(!('shading' in engineDecal(decal({ shading: 1 }), image, KEY)));
  });

  it('passes a reduced shading through, including 0 (unlit)', () => {
    assert.equal(engineDecal(decal({ shading: 0.5 }), image, KEY).shading, 0.5);
    assert.equal(engineDecal(decal({ shading: 0 }), image, KEY).shading, 0);
  });
});

describe('toDecalBound', () => {
  it('is null for a decal that did not land', () => {
    assert.equal(toDecalBound(null, 1), null);
  });

  it('reports the quad as the transformed bbox corners', () => {
    const b = toDecalBound(
      { bbox: { x: 0, y: 0, w: 100, h: 50 }, transformJs: [2, 0, 0, 2, 10, 20] },
      1,
    );
    assert.deepEqual(b?.quad, [
      { x: 10, y: 20 },
      { x: 210, y: 20 },
      { x: 210, y: 120 },
      { x: 10, y: 120 },
    ]);
    assert.deepEqual([b?.x, b?.y, b?.w, b?.h, b?.rotation], [10, 20, 200, 100, 0]);
  });

  it('divides by the device scale back into mockup space', () => {
    const b = toDecalBound(
      { bbox: { x: 0, y: 0, w: 100, h: 50 }, transformJs: [2, 0, 0, 2, 10, 20] },
      2,
    );
    assert.deepEqual([b?.x, b?.y, b?.w, b?.h], [5, 10, 100, 50]);
  });

  it('reports rotation in degrees clockwise, matching the quad', () => {
    const s = Math.SQRT1_2;
    const b = toDecalBound(
      { bbox: { x: 0, y: 0, w: 100, h: 100 }, transformJs: [s, s, -s, s, 0, 0] },
      1,
    );
    assert.ok(Math.abs((b?.rotation ?? 0) - 45) < 1e-9);
    // w/h survive the rotation: |column| is the scale, not the extent.
    assert.ok(Math.abs((b?.w ?? 0) - 100) < 1e-9);
  });
});

describe('validateRenderRequest', () => {
  it('accepts the minimal request', () => {
    validateRenderRequest(baseRequest());
  });

  it('rejects a missing surface handle', () => {
    rejects(
      () => validateRenderRequest(baseRequest({ surface: undefined as unknown as Surface })),
      /surface must be a Surface handle/,
    );
    rejects(
      () => validateRenderRequest({ ...baseRequest(), surface: 'https://x/p.jpg' } as unknown as RenderRequest),
      /surface must be a Surface handle/,
    );
  });

  it('rejects a decal without an image handle', () => {
    rejects(
      () =>
        validateRenderRequest(
          baseRequest({
            decals: [{ id: 'a', url: 'u', transform: [1, 0, 0, 1, 0, 0] }] as unknown as DecalSpec[],
          }),
        ),
      /decal a: image must be a DecalImage handle/,
    );
  });

  it('rejects size values a type cannot catch', () => {
    rejects(
      () => validateRenderRequest(baseRequest({ size: { width: NaN, height: 10 } })),
      /size\.width/,
    );
    rejects(
      () => validateRenderRequest(baseRequest({ size: { width: 10, height: 0 } })),
      /size\.height/,
    );
    rejects(
      () => validateRenderRequest(baseRequest({ size: null as unknown as undefined })),
      /size must be an object/,
    );
  });

  it('rejects a non-positive pixelScale', () => {
    rejects(() => validateRenderRequest(baseRequest({ pixelScale: 0 })), /pixelScale/);
    rejects(() => validateRenderRequest(baseRequest({ pixelScale: Infinity })), /pixelScale/);
  });

  it('rejects unknown enum values', () => {
    rejects(
      () => validateRenderRequest(baseRequest({ solver: 'dem' as 'classic' })),
      /solver/,
    );
  });

  it('rejects duplicate decal ids, which would collide in bounds', () => {
    const d = { id: 'same', image: fakeImage, transform: [1, 0, 0, 1, 0, 0] };
    rejects(
      () => validateRenderRequest(baseRequest({ decals: [d, d] as unknown as DecalSpec[] })),
      /duplicate decal id: same/,
    );
  });

  it('rejects a transform that is not 6 finite numbers', () => {
    const bad = (transform: unknown) =>
      baseRequest({
        decals: [{ id: 'a', image: fakeImage, transform }] as unknown as DecalSpec[],
      });
    rejects(() => validateRenderRequest(bad([1, 0, 0, 1, 0])), /transform must be 6/);
    rejects(() => validateRenderRequest(bad([1, 0, 0, 1, 0, NaN])), /transform must be 6/);
  });

  it('rejects a crop with a non-positive extent', () => {
    rejects(
      () =>
        validateRenderRequest(
          baseRequest({
            decals: [
              { id: 'a', image: fakeImage, transform: [1, 0, 0, 1, 0, 0], crop: [0, 0, 0, 5] },
            ] as unknown as DecalSpec[],
          }),
        ),
      /crop must be/,
    );
  });

  it('rejects a shading that is non-finite or outside [0, 1]', () => {
    const withShading = (shading: unknown) =>
      baseRequest({
        decals: [
          { id: 'a', image: fakeImage, transform: [1, 0, 0, 1, 0, 0], shading },
        ] as unknown as DecalSpec[],
      });
    for (const bad of [1.5, -0.1, NaN, Infinity, '1']) {
      rejects(() => validateRenderRequest(withShading(bad)), /shading must be/);
    }
    // The bounds themselves are legal.
    validateRenderRequest(withShading(0));
    validateRenderRequest(withShading(1));
  });
});
