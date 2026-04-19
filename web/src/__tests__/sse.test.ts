import { describe, expect, it, vi } from 'vitest';

import { isKnownEventType, parseSSEStream, type SSEEvent } from '../api/sse';

interface FakeReader {
  read: () => Promise<{ value?: Uint8Array; done: boolean }>;
}

function readerFromChunks(chunks: Array<string | Uint8Array>): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  const queue: Array<Uint8Array> = chunks.map((c) =>
    typeof c === 'string' ? encoder.encode(c) : c,
  );
  const reader: FakeReader = {
    read: () => {
      const next = queue.shift();
      if (next === undefined) {
        return Promise.resolve({ done: true });
      }
      return Promise.resolve({ value: next, done: false });
    },
  };
  return reader as unknown as ReadableStreamDefaultReader<Uint8Array>;
}

describe('parseSSEStream', () => {
  it('parses a single event delivered in one chunk', async () => {
    const events: SSEEvent[] = [];
    const reader = readerFromChunks([
      'event: phase\ndata: {"seq":1,"phase":"loading"}\n\n',
    ]);
    await parseSSEStream(reader, (e) => {
      events.push(e);
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('phase');
    expect(events[0]?.data).toBe('{"seq":1,"phase":"loading"}');
  });

  it('reassembles an event split across multiple chunks', async () => {
    const events: SSEEvent[] = [];
    const reader = readerFromChunks([
      'event: phas',
      'e\ndata: {"seq":',
      '2,"phase":"parsing"}\n',
      '\n',
    ]);
    await parseSSEStream(reader, (e) => {
      events.push(e);
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('phase');
    expect(events[0]?.data).toBe('{"seq":2,"phase":"parsing"}');
  });

  it('emits multiple events from a single chunk', async () => {
    const events: SSEEvent[] = [];
    const reader = readerFromChunks([
      'event: phase\ndata: {"seq":1}\n\nevent: warning\ndata: {"seq":2}\n\nevent: done\ndata: {"seq":3,"phase":"done"}\n\n',
    ]);
    await parseSSEStream(reader, (e) => {
      events.push(e);
    });
    expect(events.map((e) => e.type)).toEqual(['phase', 'warning', 'done']);
  });

  it('joins multi-line data fields', async () => {
    const events: SSEEvent[] = [];
    const reader = readerFromChunks([
      'event: warning\ndata: line one\ndata: line two\n\n',
    ]);
    await parseSSEStream(reader, (e) => {
      events.push(e);
    });
    expect(events[0]?.data).toBe('line one\nline two');
  });

  it('captures the id field when present', async () => {
    const events: SSEEvent[] = [];
    const reader = readerFromChunks([
      'id: 42\nevent: phase\ndata: {"seq":42}\n\n',
    ]);
    await parseSSEStream(reader, (e) => {
      events.push(e);
    });
    expect(events[0]?.id).toBe('42');
  });

  it('ignores comment lines starting with ":"', async () => {
    const events: SSEEvent[] = [];
    const reader = readerFromChunks([': keep-alive\n\nevent: phase\ndata: {}\n\n']);
    await parseSSEStream(reader, (e) => {
      events.push(e);
    });
    // The keep-alive comment block has no fields → not emitted.
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('phase');
  });

  it('handles a multi-byte utf-8 character split across chunks', async () => {
    const encoder = new TextEncoder();
    const fullPayload = 'event: warning\ndata: {"msg":"привет"}\n\n';
    const fullBytes = encoder.encode(fullPayload);
    // Slice mid-character (Cyrillic letters are 2 bytes each in UTF-8).
    const splitAt = fullPayload.indexOf('"привет"') + 4;
    const reader = readerFromChunks([fullBytes.slice(0, splitAt), fullBytes.slice(splitAt)]);
    const events: SSEEvent[] = [];
    await parseSSEStream(reader, (e) => {
      events.push(e);
    });
    expect(events[0]?.data).toContain('привет');
  });

  it('does not throw when handler is invoked', async () => {
    const handler = vi.fn();
    const reader = readerFromChunks(['event: phase\ndata: {"seq":1}\n\n']);
    await parseSSEStream(reader, handler);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('isKnownEventType', () => {
  it.each(['phase', 'partial_graph', 'warning', 'done'] as const)(
    'recognises %s',
    (name) => {
      expect(isKnownEventType(name)).toBe(true);
    },
  );

  it('rejects unknown names', () => {
    expect(isKnownEventType('nope')).toBe(false);
    expect(isKnownEventType('')).toBe(false);
  });
});
