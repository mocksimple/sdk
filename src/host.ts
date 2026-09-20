/**
 * The built-in transport: `fetch` with the host contract's semantics.
 *
 * Exported publicly (`createDefaultHost`) so an integrator decorates it
 * rather than re-implementing the contract — the clauses it satisfies are
 * exactly the ones custom hosts get wrong (every HTTP status RESOLVES; only
 * abort and transport failure reject).
 */
import type { HostRequest, HostResponse, MockupConfig, MockupHost } from '../types/mocksimple';

// ---------------------------------------------------------------------------
// Default host — plain-fetch passthrough (contract clauses 1–3; the
// production network strategy beyond this is deferred out of the slice)
// ---------------------------------------------------------------------------

export function createDefaultHost(options?: { headers?: MockupConfig['headers'] }): MockupHost {
  return {
    async fetch(request: HostRequest): Promise<HostResponse> {
      const extra =
        typeof options?.headers === 'function'
          ? await options.headers(request.role)
          : options?.headers;
      const response = await fetch(request.url, {
        method: request.method,
        // Extra headers first: SDK-provided headers win on conflict — they
        // carry the API key (contract clause 6).
        headers: { ...(extra ?? {}), ...(request.headers ?? {}) },
        // SDK-built bodies are always plain-ArrayBuffer views; the cast
        // bridges TS's ArrayBufferLike-generic typed arrays to BodyInit.
        body: request.body as Uint8Array<ArrayBuffer> | undefined,
        signal: request.signal,
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      // Every HTTP outcome resolves (clause 1); fetch() itself rejects only
      // for abort/transport failure (clause 2).
      return { status: response.status, headers, body: new Uint8Array(await response.arrayBuffer()) };
    },
  };
}

