import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiClient, ApiError } from '../api/client';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

describe('ApiClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('healthz returns parsed JSON', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      jsonResponse({
        status: 'ok',
        version: '1.0.0',
        uptime_sec: 7,
        active_projects: 0,
      }),
    );
    const client = new ApiClient({ baseUrl: '' });
    const got = await client.healthz();
    expect(got.status).toBe('ok');
    expect(got.uptime_sec).toBe(7);
  });

  it('parses the error envelope on non-2xx', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { code: 'project_not_found', message: 'gone', details: { id: 'abc' } },
        }),
        { status: 404 },
      ),
    );
    const client = new ApiClient();
    await expect(client.getGraph('abc')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
      code: 'project_not_found',
      message: 'gone',
    });
  });

  it('falls back to a synthetic code when body is empty', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response('', { status: 500 }),
    );
    const client = new ApiClient();
    const err = await client.getGraph('abc').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('server_error');
    expect((err as ApiError).status).toBe(500);
  });

  it('uploadProject maps HTTP 413 to archive_too_large', async () => {
    const xhrMock = createXhrMock({
      status: 413,
      responseText: JSON.stringify({
        error: { code: 'archive_too_large', message: 'too big' },
      }),
    });
    const client = new ApiClient({ xhrFactory: () => xhrMock });
    const file = new File(['content'], 'project.zip', { type: 'application/zip' });
    await expect(client.uploadProject(file)).rejects.toMatchObject({
      status: 413,
      code: 'archive_too_large',
    });
  });

  it('uploadProject resolves with parsed metadata on success', async () => {
    const xhrMock = createXhrMock({
      status: 201,
      responseText: JSON.stringify({
        project_id: 'pid',
        name: 'demo',
        uploaded_at: '2026-04-19T12:00:00Z',
        size_bytes: 100,
        file_count: 5,
        expires_at: '2026-04-19T12:30:00Z',
      }),
    });
    const client = new ApiClient({ xhrFactory: () => xhrMock });
    const file = new File(['content'], 'project.zip', { type: 'application/zip' });
    const meta = await client.uploadProject(file, 'demo');
    expect(meta.project_id).toBe('pid');
    expect(xhrMock.send).toHaveBeenCalled();
  });

  it('getDeadCode txt returns plain text body', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response('no dead code detected', {
        status: 200,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      }),
    );
    const client = new ApiClient();
    const text = await client.getDeadCode('pid', 'txt');
    expect(text).toBe('no dead code detected');
  });

  it('deleteProject succeeds on 204', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const client = new ApiClient();
    await expect(client.deleteProject('pid')).resolves.toBeUndefined();
  });

  it('analyzeProject streams events to onEvent and dispatches typed payloads', async () => {
    const stream = streamFromChunks([
      'event: phase\ndata: {"seq":1,"phase":"loading"}\n\n',
      'event: partial_graph\ndata: {"seq":2,"nodes":[],"edges":[]}\n\n',
      'event: done\ndata: {"seq":3,"phase":"done"}\n\n',
    ]);
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    const client = new ApiClient();

    const events: string[] = [];
    const ctrl = client.analyzeProject('pid', {}, (evt) => {
      events.push(evt.type);
    });
    expect(ctrl).toBeInstanceOf(AbortController);
    await waitFor(() => events.length >= 3);
    expect(events).toEqual(['phase', 'partial_graph', 'done']);
  });
});

interface XhrMockConfig {
  status: number;
  responseText: string;
}

interface XhrMock {
  open: (method: string, url: string) => void;
  setRequestHeader: () => void;
  send: ReturnType<typeof vi.fn>;
  upload: { addEventListener: () => void };
  addEventListener: (event: string, listener: (e?: unknown) => void) => void;
  status: number;
  responseText: string;
  responseType: string;
}

function createXhrMock(cfg: XhrMockConfig): XMLHttpRequest {
  const listeners = new Map<string, () => void>();
  const xhr: XhrMock = {
    open: vi.fn(),
    setRequestHeader: vi.fn(),
    upload: { addEventListener: vi.fn() },
    addEventListener: (event, listener) => {
      listeners.set(event, listener);
    },
    send: vi.fn(() => {
      // Mimic the browser firing `load` after the request completes.
      queueMicrotask(() => {
        xhr.status = cfg.status;
        xhr.responseText = cfg.responseText;
        const onLoad = listeners.get('load');
        if (onLoad !== undefined) {
          onLoad();
        }
      });
    }),
    status: 0,
    responseText: '',
    responseType: '',
  };
  return xhr as unknown as XMLHttpRequest;
}

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[i] ?? '';
      i += 1;
      controller.enqueue(encoder.encode(chunk));
    },
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
