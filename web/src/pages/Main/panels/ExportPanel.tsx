/**
 * Right-rail "Export" panel (design.md §3.3 wireframe; FR-21, FR-22).
 *
 * Two buttons: PNG and SVG. PNG uses the Cytoscape built-in `cy.png()`; SVG
 * uses the `cytoscape-svg` extension registered at module load. The
 * resulting payload is wrapped into a Blob and pushed to the browser via a
 * synthetic `<a download>` link.
 *
 * The PNG export targets the visible viewport at 2x scale so the output is
 * crisp on retina screens but still finishes well under 2 s for 1 000-node
 * fixtures (NFR-03 budget). The SVG export renders the entire graph (`full:
 * true`) because vector output is meant to be opened in a vector editor at
 * arbitrary zoom levels.
 */

import { useCallback, useState, type JSX } from 'react';
import type { Core } from 'cytoscape';

import { ensureCytoscapeSvgRegistered } from '../cytoscape-svg-register';
import {
  EXPORT_MIME,
  exportFilename,
  triggerDownload,
  type ExportFormat,
} from '../export';
import './ExportPanel.css';

ensureCytoscapeSvgRegistered();

export interface ExportPanelProps {
  /** Live Cytoscape core. The buttons stay disabled until it is mounted. */
  cy: Core | null;
  /** Project display name used to compose the download filename. */
  projectName: string;
  /**
   * Background colour applied behind the rendered graph. Comes from the
   * resolved theme so light / dark exports do not bleed transparent corners
   * onto the user's editor.
   */
  backgroundColor: string;
  /**
   * Optional toast surface. Errors are surfaced through this callback when
   * supplied so the user gets a single-line "export failed" notice instead
   * of a silent no-op (UI requirements §Error).
   */
  onError?: (message: string) => void;
}

/** Per-format busy flag — both formats can be in flight at once in theory. */
type Busy = Partial<Record<ExportFormat, true>>;

export function ExportPanel({
  cy,
  projectName,
  backgroundColor,
  onError,
}: ExportPanelProps): JSX.Element {
  const [busy, setBusy] = useState<Busy>({});

  const runExport = useCallback(
    async (format: ExportFormat): Promise<void> => {
      if (cy === null) {
        return;
      }
      setBusy((prev) => ({ ...prev, [format]: true }));
      try {
        const filename = exportFilename(projectName, format);
        if (format === 'png') {
          const payload = cy.png({
            output: 'blob',
            bg: backgroundColor,
            scale: 2,
            full: false,
          });
          triggerDownload(payload, filename, EXPORT_MIME.png);
          return;
        }
        const svg = cy.svg({ full: true, bg: backgroundColor });
        triggerDownload(svg, filename, EXPORT_MIME.svg);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'export failed';
        if (onError !== undefined) {
          onError(`Export ${format.toUpperCase()} failed: ${message}`);
        }
      } finally {
        setBusy((prev) => {
          const next = { ...prev };
          delete next[format];
          return next;
        });
      }
    },
    [cy, projectName, backgroundColor, onError],
  );

  const handlePngClick = useCallback(() => {
    void runExport('png');
  }, [runExport]);

  const handleSvgClick = useCallback(() => {
    void runExport('svg');
  }, [runExport]);

  const ready = cy !== null;

  return (
    <section className="export-panel" data-testid="export-panel">
      <h3 className="export-panel__title">Export</h3>
      <div className="export-panel__buttons">
        <button
          type="button"
          className="export-panel__action"
          onClick={handlePngClick}
          disabled={!ready || busy.png === true}
          data-testid="export-panel-png"
          aria-label="Export graph as PNG"
        >
          {busy.png === true ? (
            <span
              className="export-panel__spinner"
              data-testid="export-panel-png-spinner"
              aria-hidden
            />
          ) : null}
          PNG
        </button>
        <button
          type="button"
          className="export-panel__action"
          onClick={handleSvgClick}
          disabled={!ready || busy.svg === true}
          data-testid="export-panel-svg"
          aria-label="Export graph as SVG"
        >
          {busy.svg === true ? (
            <span
              className="export-panel__spinner"
              data-testid="export-panel-svg-spinner"
              aria-hidden
            />
          ) : null}
          SVG
        </button>
      </div>
    </section>
  );
}
