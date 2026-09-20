/**
 * Compile-time structural conformance of the implementation (src/index.ts)
 * against the public contract (types/mocksimple.d.ts — a verbatim copy of
 * api/mocksimple.d.ts, which stays the source of truth).
 *
 * Checked by `pnpm --dir js exec tsc --noEmit`. Nothing here runs.
 */

import type * as Api from '../types/mocksimple';
import * as impl from '../src/index';

// -- module surface: every runtime export, against the .d.ts --

impl satisfies {
  VERSION: typeof Api.VERSION;
  isSupported: typeof Api.isSupported;
  init: typeof Api.init;
  createClient: typeof Api.createClient;
  createDefaultHost: typeof Api.createDefaultHost;
  MockupError: typeof Api.MockupError;
};

// -- createClient result is a full MockupClient (methods + Symbol.dispose) --

declare const client: Awaited<ReturnType<typeof impl.createClient>>;
const clientCheck: Api.MockupClient = client;

// -- handles conform: Surface, DecalImage (data + dispose + Symbol.dispose) --

declare const surface: Awaited<ReturnType<Api.MockupClient['prepareSurface']>>;
const surfaceCheck: Api.Surface = surface;
const surfaceIsASize: Api.Size = surface;
const surfaceSolvers: readonly ('classic' | 'geodesic')[] = surface.solvers;
declare const image: Awaited<ReturnType<Api.MockupClient['loadImage']>>;
const imageCheck: Api.DecalImage = image;

// -- Render result conforms (take/drawTo/encode/dispose + plain data) --

declare const render: Awaited<ReturnType<Api.MockupClient['render']>>;
const renderCheck: Api.Render = render;

// -- default host conforms to the host contract shape --

const hostCheck: Api.MockupHost = impl.createDefaultHost({ headers: { 'x-extra': '1' } });
const hostCheckCallbackHeaders: Api.MockupHost = impl.createDefaultHost({
  headers: (role): Api.HeaderMap => (role === 'image' ? {} : { authorization: 'Bearer …' }),
});

// -- MockupError: constructor shape, instance shape, static guard --

const errorInstance: Api.MockupError = new impl.MockupError('cancelled', 'superseded', {
  retryable: false,
  detail: { reason: 'newer render' },
  cause: undefined,
});
const errorGuard: typeof Api.MockupError.is = impl.MockupError.is;
const kindCheck: Api.MockupErrorKind = errorInstance.kind;
const retryableCheck: boolean = errorInstance.retryable;

// The guard narrows by kind WITHOUT collapsing the else branch to never.
declare const someError: Api.MockupError;
if (impl.MockupError.is(someError, 'cancelled')) {
  const narrowed: 'cancelled' = someError.kind;
  void narrowed;
} else {
  const rest: Api.MockupErrorKind = someError.kind;
  void rest;
}

// -- request/result vocabulary round-trips through the implementation --

declare const requestCheck: Api.RenderRequest;
declare const boundCheck: Api.DecalBound | null;
const renderAccepts: Promise<Api.Render> = client.render(requestCheck);
const boundsAreIdKeyed: Api.DecalBound | null = render.bounds['some-id'] ?? null;
const prepareCheck: Promise<Api.Surface> = client.prepareSurface('https://example.com/photo.jpg', {
  signal: new AbortController().signal,
});
declare const blob: Blob;
declare const bitmap: ImageBitmap;
declare const imageData: ImageData;
const loadFromUrl: Promise<Api.DecalImage> = client.loadImage('https://example.com/logo.png');
const loadFromBlob: Promise<Api.DecalImage> = client.loadImage(blob);
const loadFromBitmap: Promise<Api.DecalImage> = client.loadImage(bitmap);
const loadFromData: Promise<Api.DecalImage> = client.loadImage(imageData);
const statsCheck: Api.MockupStats = client.stats();
const statsBytes: { surfaces: number; images: number } = statsCheck.bytes;
const probeCheck: Api.ProbeResult = client.probe();
const limitsCheck: Api.MockupLimits = client.limits();

// -- MockupConfig: authentication has to come from an apiKey or a host, and
// the type says so. Every @ts-expect-error below MUST error, or this file
// stops compiling — that is what makes these guards load-bearing.

declare const someHost: Api.MockupHost;
const authByKey: Api.MockupConfig = { apiKey: 'mk_live_x' };
const authByHost: Api.MockupConfig = { host: someHost };
const authByBoth: Api.MockupConfig = { apiKey: 'mk_live_x', host: someHost };
// @ts-expect-error neither a key nor a host: this config could never authenticate
const authByNeither: Api.MockupConfig = { maxOutputSize: 4096 };
// @ts-expect-error the same mistake, emptier
const authEmpty: Api.MockupConfig = {};
// @ts-expect-error residency is the caller's: there is no cache budget knob
const noCacheBudget: Api.MockupConfig = { apiKey: 'k', cacheBudgetBytes: 1 };
// @ts-expect-error there is no execution mode: everything runs on the main thread
const noMode: Api.InitOptions = { mode: 'worker' };

// -- RenderRequest: a Surface handle, not a URL; decals carry image handles.

const minimal: Api.RenderRequest = { surface, decals: [] };
const withDecal: Api.RenderRequest = {
  surface,
  decals: [{ id: 'logo', image, transform: [1, 0, 0, 1, 0, 0] }],
};
// @ts-expect-error the pre-handle shape is gone: surfaces are handles
const byUrl: Api.RenderRequest = { surfaceUrl: 's', decals: [] };
// @ts-expect-error decal pictures are handles too
const decalByUrl: Api.RenderRequest = { surface, decals: [{ id: 'a', url: 'u', transform: [1, 0, 0, 1, 0, 0] }] };
// @ts-expect-error image failures happen at loadImage(), so render has no per-decal error policy
const noDecalPolicy: Api.RenderRequest = { surface, decals: [], onDecalError: 'skip' };
// @ts-expect-error nothing to skip at render time, so nothing to report
const noFailures = render.failures;

// -- RenderRequest.size: one object, so it cannot be half-specified.

const sizeOmitted: Api.RenderRequest = { surface, decals: [] };
const sizeFromSurface: Api.RenderRequest = { surface, decals: [], size: surface };
const sizeNormalized: Api.RenderRequest = {
  surface,
  decals: [],
  size: { width: 1, height: 1 },
};
// @ts-expect-error a width without a height
const sizeHalfWidth: Api.RenderRequest = { surface, decals: [], size: { width: 800 } };
// @ts-expect-error a height without a width
const sizeHalfHeight: Api.RenderRequest = { surface, decals: [], size: { height: 600 } };
// @ts-expect-error the flat shape is gone
const sizeFlat: Api.RenderRequest = { surface, decals: [], width: 800, height: 600 };
// @ts-expect-error Size needs both members
const sizeIncomplete: Api.Size = { width: 10 };

void clientCheck;
void surfaceCheck;
void surfaceIsASize;
void surfaceSolvers;
void imageCheck;
void renderCheck;
void hostCheck;
void hostCheckCallbackHeaders;
void errorGuard;
void kindCheck;
void retryableCheck;
void boundCheck;
void renderAccepts;
void boundsAreIdKeyed;
void prepareCheck;
void loadFromUrl;
void loadFromBlob;
void loadFromBitmap;
void loadFromData;
void statsCheck;
void statsBytes;
void probeCheck;
void limitsCheck;
void authByKey;
void authByHost;
void authByBoth;
void authByNeither;
void authEmpty;
void noCacheBudget;
void noMode;
void minimal;
void withDecal;
void byUrl;
void decalByUrl;
void noDecalPolicy;
void noFailures;
void sizeOmitted;
void sizeFromSurface;
void sizeNormalized;
void sizeHalfWidth;
void sizeHalfHeight;
void sizeFlat;
void sizeIncomplete;

export {};
