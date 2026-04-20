/**
 * Helpers for the PNG/SVG export panel (T24, FR-21/FR-22).
 *
 * The actual `cy.png()` / `cy.svg()` calls live in `ExportPanel.tsx`; this
 * module owns the side effects that turn the resulting payload into a browser
 * download. Splitting them out keeps the panel component free of file-system
 * noise and lets the unit tests exercise the filename and Blob plumbing
 * without spinning up a Cytoscape core.
 */

/** Supported export formats. */
export type ExportFormat = 'png' | 'svg';

/** MIME types per format used when constructing the Blob. */
export const EXPORT_MIME: Readonly<Record<ExportFormat, string>> = {
  png: 'image/png',
  svg: 'image/svg+xml;charset=utf-8',
};

/** File extensions per format. */
export const EXPORT_EXTENSION: Readonly<Record<ExportFormat, string>> = {
  png: 'png',
  svg: 'svg',
};

/**
 * Compose `<sanitized-name>-graph-<timestamp>.<ext>`.
 *
 * Mirrors the convention used by the dead-code panel (T23) so every download
 * the SPA produces follows the same pattern. The timestamp guarantees that
 * repeated exports never overwrite each other inside the user's downloads
 * folder.
 */
export function exportFilename(
  projectName: string,
  format: ExportFormat,
  now: Date = new Date(),
): string {
  const safe = sanitizeFilename(projectName) || 'project';
  const stamp = formatTimestamp(now);
  return `${safe}-graph-${stamp}.${EXPORT_EXTENSION[format]}`;
}

/**
 * Trigger a browser download for `payload` under `filename`.
 *
 * Uses an in-memory Blob URL plus a synthetic `<a download>` so the function
 * works in plain jsdom (no `showSaveFilePicker`) and on every browser the SPA
 * targets. The blob URL is revoked after a short delay so Safari has time to
 * commit the file before garbage collection.
 */
export function triggerDownload(
  payload: Blob | string,
  filename: string,
  mime: string,
  doc: Document = document,
): void {
  const blob = typeof payload === 'string' ? new Blob([payload], { type: mime }) : payload;
  const objectUrl = URL.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  link.style.display = 'none';
  doc.body.appendChild(link);
  try {
    link.click();
  } finally {
    doc.body.removeChild(link);
    setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
    }, 60_000);
  }
}

/** Replace any character outside `[A-Za-z0-9._-]` with `_` and trim edges. */
export function sanitizeFilename(name: string): string {
  let out = '';
  for (const ch of name) {
    if (/[a-zA-Z0-9._-]/.test(ch)) {
      out += ch;
    } else {
      out += '_';
    }
  }
  return out.replace(/^[._-]+|[._-]+$/g, '');
}

/** `YYYYMMDD-HHMMSS` in the local timezone. */
export function formatTimestamp(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${String(d.getFullYear())}` +
    `${pad(d.getMonth() + 1)}` +
    `${pad(d.getDate())}` +
    `-${pad(d.getHours())}` +
    `${pad(d.getMinutes())}` +
    `${pad(d.getSeconds())}`
  );
}
