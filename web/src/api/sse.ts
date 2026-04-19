/**
 * Minimal Server-Sent Events parser for `fetch()` + `ReadableStream`.
 *
 * The browser `EventSource` API does not support POST requests with a body,
 * so we open the stream via `fetch` and parse the wire format ourselves
 * (api-contract §2). Format: `event: <type>\ndata: <json>\n\n`, optionally
 * preceded by `id: <seq>`.
 *
 * The parser is resilient to chunk boundaries: a single SSE event may arrive
 * across many chunks, and a single chunk may contain multiple events. Decoding
 * uses a streaming `TextDecoder` so multi-byte UTF-8 sequences split across
 * chunk boundaries are handled correctly.
 */

import type { SSEEventType } from './types';

export interface SSEEvent {
  /** Event name from the `event:` field. Empty string if omitted. */
  type: string;
  /** Raw `data:` payload, lines joined by `\n`. */
  data: string;
  /** Last `id:` value seen for this event, if any. */
  id?: string;
}

export type SSEEventHandler = (event: SSEEvent) => void;

/**
 * Read an SSE stream until end-of-stream and dispatch each parsed event.
 *
 * Cancel by aborting the underlying fetch (which closes the reader). The
 * caller owns the abort plumbing — `parseSSEStream` only consumes the reader.
 */
export async function parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: SSEEventHandler,
): Promise<void> {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let buffer = '';

  // Inline-loop variable for clarity; unbounded by design — caller controls
  // termination via stream end or AbortController.
  for (;;) {
    const { value, done } = await reader.read();
    if (value !== undefined) {
      buffer += decoder.decode(value, { stream: true });
      buffer = drainEvents(buffer, onEvent);
    }
    if (done) {
      // Flush any trailing decoder state.
      buffer += decoder.decode();
      // A well-behaved server terminates with `\n\n`; if the last event lacks
      // it we still try to parse what is left so callers don't lose `done`.
      if (buffer.length > 0) {
        const flushed = `${buffer}\n\n`;
        drainEvents(flushed, onEvent);
      }
      return;
    }
  }
}

/**
 * Extract complete events from `buffer`, dispatch them via `onEvent`, and
 * return the unparsed remainder (an incomplete event still being received).
 */
function drainEvents(buffer: string, onEvent: SSEEventHandler): string {
  let cursor = 0;
  let working = buffer;
  // The SSE separator is `\n\n`, but we accept `\r\n\r\n` too for safety.
  const normalized = working.replace(/\r\n/g, '\n');
  // If normalization changed length, replay against `normalized`.
  if (normalized.length !== working.length) {
    working = normalized;
  }
  for (
    let boundary = working.indexOf('\n\n', cursor);
    boundary !== -1;
    boundary = working.indexOf('\n\n', cursor)
  ) {
    const block = working.slice(cursor, boundary);
    cursor = boundary + 2;
    const parsed = parseEventBlock(block);
    if (parsed !== null) {
      onEvent(parsed);
    }
  }
  return working.slice(cursor);
}

/** Parse a single event block (text between two `\n\n` delimiters). */
function parseEventBlock(block: string): SSEEvent | null {
  if (block.length === 0) {
    return null;
  }
  let type = '';
  const dataLines: string[] = [];
  let id: string | undefined;
  let hasContent = false;

  for (const line of block.split('\n')) {
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith(':')) {
      // SSE comment — ignore (used by some servers as keep-alive).
      continue;
    }
    const colon = line.indexOf(':');
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(' ')) {
        value = value.slice(1);
      }
    }
    hasContent = true;
    switch (field) {
      case 'event':
        type = value;
        break;
      case 'data':
        dataLines.push(value);
        break;
      case 'id':
        id = value;
        break;
      // `retry` is meaningful only for browser EventSource; we drop it.
      default:
        break;
    }
  }

  if (!hasContent) {
    return null;
  }
  const event: SSEEvent = { type, data: dataLines.join('\n') };
  if (id !== undefined) {
    event.id = id;
  }
  return event;
}

/** Type guard for the four event names defined in api-contract §2. */
export function isKnownEventType(type: string): type is SSEEventType {
  return type === 'phase' || type === 'partial_graph' || type === 'warning' || type === 'done';
}
