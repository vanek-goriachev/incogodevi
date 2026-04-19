/**
 * Typed HTTP client for the Go Dependencies Visualizer backend.
 *
 * Wraps `fetch` for JSON endpoints, `XMLHttpRequest` for upload progress
 * (the Fetch standard still lacks `upload.onprogress`), and `fetch` +
 * `ReadableStream` for SSE. All methods reject with `ApiError` on non-2xx
 * responses, parsing the canonical error envelope from `docs/api-contract.md`.
 */

import { isKnownEventType, parseSSEStream } from './sse';
import type {
  ApiErrorPayload,
  DeadCodeReport,
  DoneEvent,
  EntryPointSpec,
  Filters,
  Graph,
  HealthResponse,
  PartialGraphEvent,
  PhaseEvent,
  ProjectMeta,
  SSEEventType,
  WarningEvent,
} from './types';

/** Error thrown by `ApiClient` when the backend returns a non-2xx response. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, payload: ApiErrorPayload) {
    super(payload.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = payload.code;
    this.details = payload.details;
  }
}

/** Optional query-string parameters for `GET /api/projects/{id}/graph`. */
export interface GraphRequestOptions {
  aggregate?: 'auto' | 'package' | 'none';
  include_dead?: boolean;
  scope?: string;
}

/** SSE callback union keyed by event type for type-safe payloads. */
export type AnalyzeEventCallback = (
  event:
    | { type: 'phase'; payload: PhaseEvent }
    | { type: 'partial_graph'; payload: PartialGraphEvent }
    | { type: 'warning'; payload: WarningEvent }
    | { type: 'done'; payload: DoneEvent }
    | { type: 'unknown'; name: string; raw: string },
) => void;

/**
 * Optional error handler invoked when the SSE connection rejects before any
 * event arrives (HTTP 4xx/5xx, network drop, malformed stream). The callback
 * receives the same `ApiError` that would surface from a JSON endpoint.
 */
export type AnalyzeErrorCallback = (err: ApiError) => void;

/** Optional progress callback for multipart upload. */
export type UploadProgressCallback = (loaded: number, total: number | undefined) => void;

export interface ApiClientOptions {
  /** Base URL prepended to every request. Empty string = same-origin. */
  baseUrl?: string;
  /** Replaceable `fetch` for tests and SSR. Defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
  /** Replaceable `XMLHttpRequest` constructor for tests. */
  xhrFactory?: () => XMLHttpRequest;
}

/**
 * Default base URL — empty string means "use same-origin". In Vite dev mode,
 * the dev proxy maps `/api → :8080`; in production the SPA is served from the
 * Go binary on the same origin.
 */
function defaultBaseUrl(): string {
  const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;
  return env?.['VITE_API_BASE'] ?? '';
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly xhrFactory: () => XMLHttpRequest;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? defaultBaseUrl()).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.xhrFactory = options.xhrFactory ?? (() => new XMLHttpRequest());
  }

  /** `GET /api/healthz` — never returns a non-2xx in normal operation. */
  async healthz(): Promise<HealthResponse> {
    return this.requestJson<HealthResponse>('GET', '/api/healthz');
  }

  /**
   * `POST /api/projects` — multipart upload of a Go project ZIP.
   *
   * Uses XMLHttpRequest because the Fetch API does not expose upload
   * progress events as of the current spec (api-contract §1).
   */
  uploadProject(
    file: File,
    name?: string,
    onProgress?: UploadProgressCallback,
  ): Promise<ProjectMeta> {
    return new Promise((resolve, reject) => {
      const xhr = this.xhrFactory();
      const url = this.url('/api/projects');
      xhr.open('POST', url);
      xhr.responseType = 'text';
      if (onProgress !== undefined) {
        xhr.upload.addEventListener('progress', (evt) => {
          onProgress(evt.loaded, evt.lengthComputable ? evt.total : undefined);
        });
      }
      xhr.addEventListener('load', () => {
        const status = xhr.status;
        const body = typeof xhr.responseText === 'string' ? xhr.responseText : '';
        if (status >= 200 && status < 300) {
          try {
            resolve(JSON.parse(body) as ProjectMeta);
          } catch (err) {
            reject(wrapJsonError(err, status, body));
          }
          return;
        }
        reject(buildApiError(status, body));
      });
      xhr.addEventListener('error', () => {
        reject(new ApiError(0, { code: 'network_error', message: 'upload network error' }));
      });
      xhr.addEventListener('abort', () => {
        reject(new ApiError(0, { code: 'aborted', message: 'upload aborted' }));
      });

      const form = new FormData();
      form.append('archive', file);
      if (name !== undefined && name !== '') {
        form.append('name', name);
      }
      xhr.send(form);
    });
  }

  /**
   * `POST /api/projects/{id}/analyze` — open the SSE stream and dispatch
   * typed events to `onEvent`. Returns an `AbortController`; calling
   * `.abort()` closes the connection (server sees `ctx.Err() = canceled`).
   *
   * Pre-stream rejections (HTTP 4xx/5xx body, dropped TCP) are surfaced
   * through the optional `onError` callback so the caller can render a
   * fallback UI without monkey-patching `unhandledrejection`.
   */
  analyzeProject(
    projectId: string,
    spec: { entry_points?: EntryPointSpec; filters?: Filters },
    onEvent: AnalyzeEventCallback,
    onError?: AnalyzeErrorCallback,
  ): AbortController {
    const controller = new AbortController();
    this.runAnalyzeStream(projectId, spec, onEvent, controller).catch((err: unknown) => {
      if (controller.signal.aborted) {
        return;
      }
      const wrapped = err instanceof ApiError
        ? err
        : new ApiError(0, {
            code: 'network_error',
            message: err instanceof Error ? err.message : 'analyze stream failed',
          });
      if (onError !== undefined) {
        onError(wrapped);
      }
    });
    return controller;
  }

  /** `GET /api/projects/{id}/graph` — full graph snapshot. */
  async getGraph(projectId: string, opts: GraphRequestOptions = {}): Promise<Graph> {
    const params = new URLSearchParams();
    if (opts.aggregate !== undefined) {
      params.set('aggregate', opts.aggregate);
    }
    if (opts.include_dead !== undefined) {
      params.set('include_dead', opts.include_dead ? 'true' : 'false');
    }
    if (opts.scope !== undefined && opts.scope !== '') {
      params.set('scope', opts.scope);
    }
    const query = params.toString();
    const path = `/api/projects/${encodeURIComponent(projectId)}/graph${query ? `?${query}` : ''}`;
    return this.requestJson<Graph>('GET', path);
  }

  /**
   * `GET /api/projects/{id}/dead-code` — TXT or JSON report.
   * Returns `string` for TXT and `DeadCodeReport` for JSON.
   */
  async getDeadCode(projectId: string, format: 'json'): Promise<DeadCodeReport>;
  async getDeadCode(projectId: string, format: 'txt'): Promise<string>;
  async getDeadCode(
    projectId: string,
    format: 'json' | 'txt',
  ): Promise<DeadCodeReport | string> {
    const path = `/api/projects/${encodeURIComponent(projectId)}/dead-code?format=${format}`;
    const response = await this.fetchImpl(this.url(path), {
      method: 'GET',
      headers:
        format === 'json'
          ? { Accept: 'application/json' }
          : { Accept: 'text/plain;charset=utf-8' },
    });
    if (!response.ok) {
      throw await responseToApiError(response);
    }
    if (format === 'json') {
      return (await response.json()) as DeadCodeReport;
    }
    return await response.text();
  }

  /** `DELETE /api/projects/{id}` — idempotent removal. */
  async deleteProject(projectId: string): Promise<void> {
    const path = `/api/projects/${encodeURIComponent(projectId)}`;
    const response = await this.fetchImpl(this.url(path), { method: 'DELETE' });
    if (!response.ok) {
      throw await responseToApiError(response);
    }
  }

  private url(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  private async requestJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit = { method, headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { ...init.headers, 'Content-Type': 'application/json' };
    }
    const response = await this.fetchImpl(this.url(path), init);
    if (!response.ok) {
      throw await responseToApiError(response);
    }
    return (await response.json()) as T;
  }

  private async runAnalyzeStream(
    projectId: string,
    spec: { entry_points?: EntryPointSpec; filters?: Filters },
    onEvent: AnalyzeEventCallback,
    controller: AbortController,
  ): Promise<void> {
    const path = `/api/projects/${encodeURIComponent(projectId)}/analyze`;
    let response: Response;
    try {
      response = await this.fetchImpl(this.url(path), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(spec),
      });
    } catch (err) {
      // AbortController cancellation surfaces as a DOMException — treat as
      // a clean close, not an error event for the consumer.
      if (controller.signal.aborted) {
        return;
      }
      throw err;
    }

    if (!response.ok || response.body === null) {
      throw await responseToApiError(response);
    }

    const reader = response.body.getReader();
    try {
      await parseSSEStream(reader, (raw) => {
        const name = raw.type;
        if (!isKnownEventType(name)) {
          onEvent({ type: 'unknown', name, raw: raw.data });
          return;
        }
        try {
          const payload = JSON.parse(raw.data) as unknown;
          dispatchTyped(name, payload, onEvent);
        } catch {
          // Malformed payload from the server — surface as unknown so the
          // consumer can decide whether to bail out or ignore.
          onEvent({ type: 'unknown', name, raw: raw.data });
        }
      });
    } finally {
      reader.releaseLock();
    }
  }
}

function dispatchTyped(
  name: SSEEventType,
  payload: unknown,
  onEvent: AnalyzeEventCallback,
): void {
  switch (name) {
    case 'phase':
      onEvent({ type: 'phase', payload: payload as PhaseEvent });
      return;
    case 'partial_graph':
      onEvent({ type: 'partial_graph', payload: payload as PartialGraphEvent });
      return;
    case 'warning':
      onEvent({ type: 'warning', payload: payload as WarningEvent });
      return;
    case 'done':
      onEvent({ type: 'done', payload: payload as DoneEvent });
      return;
  }
}

async function responseToApiError(response: Response): Promise<ApiError> {
  let body = '';
  try {
    body = await response.text();
  } catch {
    // ignore — fall through to generic error
  }
  return buildApiError(response.status, body);
}

function buildApiError(status: number, body: string): ApiError {
  if (body.length > 0) {
    try {
      const parsed = JSON.parse(body) as { error?: ApiErrorPayload };
      if (parsed.error !== undefined && typeof parsed.error.code === 'string') {
        return new ApiError(status, parsed.error);
      }
    } catch {
      // not JSON — fall through to fallback
    }
  }
  return new ApiError(status, {
    code: fallbackCode(status),
    message: body !== '' ? body : `HTTP ${String(status)}`,
  });
}

function fallbackCode(status: number): string {
  if (status === 0) {
    return 'network_error';
  }
  if (status === 413) {
    return 'archive_too_large';
  }
  if (status === 404) {
    return 'not_found';
  }
  if (status === 409) {
    return 'conflict';
  }
  if (status >= 500) {
    return 'server_error';
  }
  return 'http_error';
}

function wrapJsonError(err: unknown, status: number, body: string): ApiError {
  const message = err instanceof Error ? err.message : 'malformed JSON response';
  return new ApiError(status, {
    code: 'invalid_response',
    message,
    details: { body: body.slice(0, 256) },
  });
}
