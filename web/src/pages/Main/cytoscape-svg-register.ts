/**
 * Module-level registration helper for the `cytoscape-svg` extension.
 *
 * Cytoscape's `use()` is idempotent for the same extension reference but
 * still runs through internal bookkeeping each call. Wrapping it in a guard
 * keeps the registration to a single side effect and matches the pattern
 * used by `GraphCanvas.tsx` for `cytoscape-fcose`.
 */

import cytoscape from 'cytoscape';
import cytoscapeSvg from 'cytoscape-svg';

let registered = false;

/** Register the cytoscape-svg extension exactly once per page. */
export function ensureCytoscapeSvgRegistered(): void {
  if (registered) {
    return;
  }
  cytoscape.use(cytoscapeSvg);
  registered = true;
}
