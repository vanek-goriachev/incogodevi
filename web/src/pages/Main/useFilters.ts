/**
 * `useFilters` — bridge between the `FiltersPanel` spec and Cytoscape.
 *
 * Hidden nodes get the `.hidden` class; the stylesheet rule then collapses
 * them to `display: none`. Edges incident to a hidden node also become
 * `.hidden` so the canvas does not show dangling lines. Highlight from the
 * `find` query attaches a `.match` class on matching nodes; the rest get
 * `.dim` so the matches stand out.
 *
 * All class flips are batched through `cy.batch(...)` so even on the 1000-node
 * upper bound the toggle round-trip stays inside the NFR-03 100 ms budget.
 *
 * The hook exposes nothing — it works purely through side effects on the
 * passed `cy` ref. The only other side effect is one-time installation of the
 * `.hidden`/`.match`/`.dim` selectors into the live stylesheet so external
 * stylesheet rebuilds (theme switch) keep them in scope.
 */

import { useEffect } from 'react';
import type { Core, NodeSingular, StylesheetStyle } from 'cytoscape';

import { ALL_NODE_KINDS } from '../../api/types';
import type { FilterSpec } from './panels/filterSpec';

/**
 * Selectors maintained by this hook; appended to the live stylesheet.
 *
 * NOTE: the `.hidden` selectors are NOT added here — they live in
 * `buildStylesheet` (graph-styles.ts) so they are part of the base stylesheet
 * Cytoscape receives at construction time. Cytoscape 3.x renders ignore a
 * `display: none` rule attached incrementally via `cy.style().selector(...)`
 * for elements that were already painted, which is exactly the toggle path
 * the filters panel uses.
 */
const FILTER_STYLE_RULES: StylesheetStyle[] = [
  {
    selector: 'node.match',
    style: {
      'overlay-color': '#facc15',
      'overlay-opacity': 0.35,
      'overlay-padding': 6,
      'border-color': '#a16207',
      'border-width': 3,
    },
  },
  {
    selector: 'node.dim',
    style: {
      opacity: 0.18,
    },
  },
  {
    selector: 'edge.dim',
    style: {
      opacity: 0.08,
    },
  },
];

/**
 * Returns the Cytoscape selector that matches every node disabled by the
 * current spec. Empty string means "no kind is hidden" so the caller can skip
 * the query altogether.
 */
function buildHiddenKindSelector(spec: FilterSpec): string {
  const hidden: string[] = [];
  for (const k of ALL_NODE_KINDS) {
    if (spec.kinds[k] === false) {
      hidden.push(`node[kind="${k}"]`);
    }
  }
  return hidden.join(', ');
}

/**
 * Apply `spec` to `cy`. Returns nothing; the function is idempotent so it
 * can be called from a `useEffect` whenever any input changes.
 */
export function applyFilters(cy: Core, spec: FilterSpec): void {
  cy.batch(() => {
    cy.nodes().removeClass('hidden match dim');
    cy.edges().removeClass('hidden dim');

    // ---- 1. hide nodes by kind ----
    const kindSelector = buildHiddenKindSelector(spec);
    if (kindSelector !== '') {
      cy.$(kindSelector).addClass('hidden');
    }

    // ---- 2. hide nodes by package (when in subset mode) ----
    if (spec.packages.mode === 'subset') {
      const allowed = new Set(spec.packages.selected);
      cy.nodes().forEach((node: NodeSingular) => {
        const pkg = node.data('package') as string | undefined;
        if (pkg !== undefined && pkg !== '' && !allowed.has(pkg)) {
          node.addClass('hidden');
        }
      });
    }

    // ---- 2b. hide external (stdlib / third-party) nodes when requested ----
    if (spec.hideExternal) {
      cy.nodes().forEach((node: NodeSingular) => {
        if (node.data('external') === true) {
          node.addClass('hidden');
        }
      });
    }

    // ---- 3. hide edges that lost an endpoint ----
    cy.edges().forEach((edge) => {
      if (edge.source().hasClass('hidden') || edge.target().hasClass('hidden')) {
        edge.addClass('hidden');
      }
    });

    // ---- 4. find-by-name highlight ----
    const needle = spec.find.trim().toLowerCase();
    if (needle === '') {
      return;
    }
    let matched = 0;
    cy.nodes().forEach((node: NodeSingular) => {
      if (node.hasClass('hidden')) {
        return;
      }
      const name = String(node.data('name') ?? '').toLowerCase();
      const id = node.id().toLowerCase();
      if (name.includes(needle) || id.includes(needle)) {
        node.addClass('match');
        matched += 1;
      }
    });
    if (matched > 0) {
      cy.nodes().forEach((node) => {
        if (!node.hasClass('hidden') && !node.hasClass('match')) {
          node.addClass('dim');
        }
      });
      cy.edges().forEach((edge) => {
        if (edge.hasClass('hidden')) {
          return;
        }
        if (!edge.source().hasClass('match') || !edge.target().hasClass('match')) {
          edge.addClass('dim');
        }
      });
    }
  });
}

/**
 * Install the filter stylesheet rules into the live Cytoscape style.
 *
 * The base stylesheet is rebuilt from scratch on theme changes (see
 * `MainView.useThemeTokens`); to survive that rebuild this routine is invoked
 * inside the same effect that watches the `theme` token so the rules are
 * re-appended afterwards.
 */
export function ensureFilterStyleRules(cy: Core): void {
  let styleApi: unknown;
  try {
    styleApi = cy.style();
  } catch {
    // Headless / null-renderer Cytoscape may refuse to spin up the style
    // engine until at least one render pass occurs. Filter classes still
    // work — they just live in the data layer; nothing more to do.
    return;
  }
  const styleSelector = (styleApi as {
    selector?: (s: string) => {
      style: (props: Record<string, unknown>) => { update: () => void };
    };
  }).selector;
  if (typeof styleSelector !== 'function') {
    // jsdom-null renderer or stripped-down test double: nothing to do.
    return;
  }
  for (const rule of FILTER_STYLE_RULES) {
    const props = rule.style as unknown as Record<string, unknown>;
    try {
      styleSelector(rule.selector).style(props).update();
    } catch {
      // Style merging can fail when the engine is still being torn down
      // (rapid theme toggle + unmount); the next call will re-install.
      return;
    }
  }
}

/**
 * React hook variant: re-applies the filter spec whenever `spec` or the
 * Cytoscape instance change. Pass the live `Core` ref maintained by
 * `GraphCanvas` (or `null` when the canvas is not mounted yet).
 */
export function useFilters(cy: Core | null, spec: FilterSpec): void {
  useEffect(() => {
    if (cy === null) {
      return;
    }
    ensureFilterStyleRules(cy);
    applyFilters(cy, spec);
  }, [cy, spec]);
}
