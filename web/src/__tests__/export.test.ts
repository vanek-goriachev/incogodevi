/**
 * Unit tests for the export helpers (T24).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  exportFilename,
  formatTimestamp,
  sanitizeFilename,
  triggerDownload,
} from '../pages/Main/export';

describe('export helpers', () => {
  describe('sanitizeFilename', () => {
    it('keeps safe characters', () => {
      expect(sanitizeFilename('foo-bar_1.0')).toBe('foo-bar_1.0');
    });

    it('replaces unsafe characters with underscore', () => {
      expect(sanitizeFilename('github.com/acme/example')).toBe(
        'github.com_acme_example',
      );
    });

    it('trims leading and trailing punctuation', () => {
      expect(sanitizeFilename('__weird__')).toBe('weird');
    });

    it('returns empty string for fully unsafe input', () => {
      expect(sanitizeFilename('!!!')).toBe('');
    });
  });

  describe('formatTimestamp', () => {
    it('produces YYYYMMDD-HHMMSS format', () => {
      const stamp = formatTimestamp(new Date(2026, 3, 19, 14, 5, 9));
      expect(stamp).toBe('20260419-140509');
    });
  });

  describe('exportFilename', () => {
    it('includes project name, format and timestamp', () => {
      const name = exportFilename(
        'github.com/acme/example',
        'png',
        new Date(2026, 3, 19, 10, 0, 0),
      );
      expect(name).toBe('github.com_acme_example-graph-20260419-100000.png');
    });

    it('falls back to "project" when sanitisation strips everything', () => {
      const name = exportFilename('!!', 'svg', new Date(2026, 0, 1, 0, 0, 0));
      expect(name).toBe('project-graph-20260101-000000.svg');
    });
  });

  describe('triggerDownload', () => {
    it('creates a download link, clicks it and revokes the blob URL later', () => {
      vi.useFakeTimers();
      const objectUrl = 'blob:http://localhost/dummy';
      const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockReturnValue(objectUrl);
      const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

      triggerDownload('hello', 'graph.svg', 'image/svg+xml');

      expect(createObjectURL).toHaveBeenCalledOnce();
      expect(revokeObjectURL).not.toHaveBeenCalled();

      vi.advanceTimersByTime(60_000);
      expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);

      vi.useRealTimers();
    });
  });
});
