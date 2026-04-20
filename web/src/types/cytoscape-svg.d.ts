/**
 * Ambient module declaration for the `cytoscape-svg` extension.
 *
 * The community package (kaluginserg/cytoscape-svg, v0.4.x) ships UMD
 * JavaScript without bundled type definitions. After registering the
 * extension via `cytoscape.use(cytoscapeSvg)` Cytoscape exposes a `svg()`
 * method on the core that mirrors the signature of the built-in `png()`
 * helper but returns a serialised SVG document as a string.
 *
 * The augmentation lives inside `declare namespace cytoscape` (mirroring how
 * the upstream `@types/cytoscape` package is structured: it uses
 * `export = cytoscape` plus a global namespace).
 */

declare module 'cytoscape-svg' {
  import type { Ext } from 'cytoscape';
  const cytoscapeSvg: Ext;
  export default cytoscapeSvg;
}

declare namespace cytoscape {
  interface SvgExportOptions {
    /** When true, render the entire graph; when false (default), the viewport. */
    full?: boolean;
    /** Background colour applied behind the graph (CSS colour string). */
    bg?: string;
    /** Multiplier applied to coordinates; default 1. */
    scale?: number;
    /** Cap on the rendered width when no explicit scale is supplied. */
    maxWidth?: number;
    /** Cap on the rendered height when no explicit scale is supplied. */
    maxHeight?: number;
  }

  interface CoreExport {
    /** Serialise the current graph as an SVG document. */
    svg(options?: SvgExportOptions): string;
  }
}
