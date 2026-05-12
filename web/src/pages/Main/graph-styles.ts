/**
 * Cytoscape stylesheet generator for the dependency graph.
 *
 * Mirrors `docs/design.md` §5.1 (node shapes/colors per kind), §5.2 (edge
 * line styles per kind), §5.3 (dead overlay) and §5.4 (entry-point overlay).
 *
 * Colors are passed in explicitly so the caller controls theme tokens
 * (light/dark) — this module knows nothing about CSS variables, which keeps
 * it trivially testable and decouples the styling rules from the runtime
 * theme observer that lives in `MainView.tsx`.
 */

import type { StylesheetStyle } from 'cytoscape';

import type { EdgeKind, NodeKind } from '../../api/types';

/** Cytoscape node-shape values used by `NODE_KIND_STYLES`. */
export type NodeShape =
  | 'round-rectangle'
  | 'rectangle'
  | 'diamond'
  | 'ellipse'
  | 'hexagon';

/** Per-kind visual definition, derived from design.md §5.1. */
export interface NodeKindStyle {
  shape: NodeShape;
  fill: string;
  border: string;
  borderWidth: number;
  width: number;
  height: number;
}

/** Per-kind edge visual definition, derived from design.md §5.2. */
export interface EdgeKindStyle {
  color: string;
  width: number;
  lineStyle: 'solid' | 'dashed' | 'dotted';
  arrow: 'triangle' | 'triangle-tee' | 'none';
}

/** Resolved theme tokens needed for Cytoscape styling. */
export interface ThemeTokens {
  fg: string;
  fgMuted: string;
  bg: string;
  bgElevated: string;
  accent: string;
  border: string;
}

/** Static palette of the eight node kinds (light defaults from design.md §5.1). */
export const NODE_KIND_STYLES: Readonly<Record<NodeKind, NodeKindStyle>> = {
  package: {
    shape: 'round-rectangle',
    fill: '#dbeafe',
    border: '#1e40af',
    borderWidth: 2,
    width: 180,
    height: 46,
  },
  struct: {
    shape: 'rectangle',
    fill: '#e0f2fe',
    border: '#0369a1',
    borderWidth: 2,
    width: 140,
    height: 36,
  },
  interface: {
    shape: 'diamond',
    fill: '#ede9fe',
    border: '#6d28d9',
    borderWidth: 2,
    width: 140,
    height: 36,
  },
  func: {
    shape: 'ellipse',
    fill: '#fef3c7',
    border: '#b45309',
    borderWidth: 1.5,
    width: 120,
    height: 34,
  },
  method: {
    shape: 'ellipse',
    fill: '#fffbeb',
    border: '#92400e',
    borderWidth: 1.5,
    width: 120,
    height: 34,
  },
  field: {
    shape: 'round-rectangle',
    fill: '#f1f5f9',
    border: '#475569',
    borderWidth: 1,
    width: 100,
    height: 24,
  },
  var: {
    shape: 'hexagon',
    fill: '#dcfce7',
    border: '#15803d',
    borderWidth: 1,
    width: 100,
    height: 28,
  },
  const: {
    shape: 'hexagon',
    fill: '#dcfce7',
    border: '#15803d',
    borderWidth: 1,
    width: 100,
    height: 28,
  },
};

/** Static palette of the six edge kinds (design.md §5.2). */
export const EDGE_KIND_STYLES: Readonly<Record<EdgeKind, EdgeKindStyle>> = {
  imports: { color: '#1e40af', width: 1.5, lineStyle: 'solid', arrow: 'triangle' },
  contains: { color: '#94a3b8', width: 1, lineStyle: 'solid', arrow: 'none' },
  calls: { color: '#b45309', width: 1.5, lineStyle: 'solid', arrow: 'triangle' },
  embeds: { color: '#0369a1', width: 2, lineStyle: 'solid', arrow: 'triangle' },
  implements: { color: '#6d28d9', width: 2, lineStyle: 'dashed', arrow: 'triangle' },
  references: { color: '#64748b', width: 1, lineStyle: 'dotted', arrow: 'triangle-tee' },
};

/** All node kinds in the order used by the filters panel (T21 sanity). */
export const NODE_KIND_ORDER: readonly NodeKind[] = [
  'package',
  'struct',
  'interface',
  'func',
  'method',
  'field',
  'var',
  'const',
];

/**
 * Build the Cytoscape stylesheet array.
 *
 * The resulting array is intentionally flat (one selector per entry) so it
 * can be diffed and applied with `cy.style().fromJson(...).update()` when the
 * theme changes without dropping selections or layout positions.
 */
export function buildStylesheet(theme: ThemeTokens): StylesheetStyle[] {
  const sheet: StylesheetStyle[] = [];

  // ---- base node styles ----
  sheet.push({
    selector: 'node',
    style: {
      label: 'data(name)',
      'text-valign': 'center',
      'text-halign': 'center',
      'font-family': "ui-monospace, 'SFMono-Regular', 'JetBrains Mono', Menlo, Consolas, monospace",
      'font-size': 12,
      color: theme.fg,
      'text-wrap': 'ellipsis',
      'text-max-width': '160px',
      'border-style': 'solid',
      'background-opacity': 1,
    },
  });

  // ---- per-kind nodes ----
  for (const kind of NODE_KIND_ORDER) {
    const k = NODE_KIND_STYLES[kind];
    sheet.push({
      selector: `node[kind="${kind}"]`,
      style: {
        shape: k.shape,
        'background-color': k.fill,
        'border-color': k.border,
        'border-width': k.borderWidth,
        width: k.width,
        height: k.height,
      },
    });
  }

  // ---- adaptive package node sizing (T20 hot-fix) ----
  // The static 180-px width from `NODE_KIND_STYLES.package` is too narrow for
  // labels like "syscall (2920)" that the package-aggregation produces. Let
  // Cytoscape size package nodes from their label content so nothing is
  // clipped. The `'label'` value is documented for the sizing properties but
  // typed as `number` in the SDK, hence the cast through `unknown`.
  sheet.push({
    selector: 'node[kind="package"]',
    style: {
      width: 'label' as unknown as number,
      height: 'label' as unknown as number,
      padding: '12px',
      'text-max-width': '300px',
    },
  });

  // ---- aggregated package badge (T24, FR-18) ----
  // When `aggregate=package` collapses a graph the backend annotates each
  // package node with `child_count`. `GraphCanvas.syncElements` mirrors the
  // pair into a `display_label` data field; when present, the per-kind label
  // overrides the default `data(name)` mapper to read it.
  sheet.push({
    selector: 'node[kind="package"][display_label]',
    style: {
      label: 'data(display_label)',
      'font-weight': 600,
      'border-width': 3,
    },
  });

  // ---- partial-dead package badge (R4-5) ----
  // Backend tags an aggregated package with `partial_dead: true` when at
  // least one but not all of its children are unreachable. Render with an
  // amber dashed border so the user can tell at a glance that the package
  // contains dead code without itself being fully dead. The rule is keyed
  // off the data attribute, not a class, so it survives applyExpansion's
  // class manipulations.
  sheet.push({
    selector: 'node[kind="package"][?partial_dead]',
    style: {
      'border-color': '#b45309',
      'border-style': 'dashed',
      'border-width': 3,
    },
  });

  // ---- fully-dead package badge (R4-5) ----
  // `fully_dead: true` means every child is unreachable. Render with the
  // standard dead overlay (amber background, faded) plus a heavier dashed
  // border so it stands out from the partial-dead variant.
  sheet.push({
    selector: 'node[kind="package"][?fully_dead]',
    style: {
      'background-color': '#fef3c7',
      'border-color': '#b45309',
      'border-style': 'dashed',
      'border-width': 3.5,
      opacity: 0.7,
    },
  });

  // ---- expanded package compound parent (R4-4) ----
  // After `applyExpansion` promotes the aggregated package node into a
  // Cytoscape compound parent (children carry `parent: <pkgNodeId>` data),
  // it tags the parent with `pkg-compound`. Strip the badge fill and use a
  // dashed accent border so the parent reads as a container box rather than
  // a node in its own right. The label moves to the top so it does not
  // overlap with the children. `:parent` selector is applied so the rule
  // also matches when the children land via the imperative `cy.add()` call.
  // Padding is intentionally small — the compound's "box" should hug its
  // members. Pre-R5 we used 24 px which left a wide halo that the user read
  // as wasted space (R5 Bug #1).
  sheet.push({
    selector: 'node.pkg-compound, node[kind="package"]:parent',
    style: {
      'background-color': theme.bgElevated,
      'background-opacity': 0.45,
      'border-color': theme.accent,
      'border-style': 'dashed',
      'border-width': 2,
      'text-valign': 'top',
      'text-halign': 'center',
      'font-weight': 700,
      padding: '14px',
      'z-index': 0,
    },
  });

  // ---- selection ring ----
  sheet.push({
    selector: 'node:selected',
    style: {
      'overlay-color': theme.accent,
      'overlay-opacity': 0.18,
      'overlay-padding': 6,
    },
  });

  // ---- dead-code overlay (design.md §5.3) ----
  sheet.push({
    selector: 'node.dead',
    style: {
      opacity: 0.45,
      'border-style': 'dashed',
    },
  });

  // ---- entry-point overlay (design.md §5.4) ----
  sheet.push({
    selector: 'node.entry',
    style: {
      'border-width': 3.5,
      'border-style': 'double',
    },
  });

  // ---- base edge styles ----
  sheet.push({
    selector: 'edge',
    style: {
      'curve-style': 'bezier',
      'target-arrow-shape': 'triangle',
      'arrow-scale': 0.9,
      opacity: 0.85,
    },
  });

  // ---- per-kind edges ----
  for (const [kind, style] of Object.entries(EDGE_KIND_STYLES) as [EdgeKind, EdgeKindStyle][]) {
    sheet.push({
      selector: `edge[kind="${kind}"]`,
      style: {
        'line-color': style.color,
        'target-arrow-color': style.color,
        width: style.width,
        'line-style': style.lineStyle,
        'target-arrow-shape': style.arrow === 'none' ? 'none' : style.arrow,
      },
    });
  }

  // ---- dead edges (faded together with their endpoints) ----
  sheet.push({
    selector: 'edge.dead',
    style: {
      opacity: 0.3,
    },
  });

  // ---- dead-mode hide classes (design.md §5.3, applied by useDeadMode) ----
  sheet.push({
    selector: '.mode-hide-live',
    style: {
      display: 'none',
    },
  });
  sheet.push({
    selector: '.mode-hide-dead',
    style: {
      display: 'none',
    },
  });

  // ---- filter-driven hide class (left-rail FiltersPanel + useFilters) ----
  // Cytoscape only honours `display: none` reliably when the rule is part of
  // the base stylesheet handed to `cytoscape({...})`. Adding it incrementally
  // via `cy.style().selector('.hidden').style({display:'none'}).update()` is
  // ignored by the renderer in 3.x for already-rendered elements, so the
  // FiltersPanel toggles appeared to do nothing. Scoping the selector to
  // `node` and `edge` separately matches Cytoscape's selector grammar; bare
  // `.hidden` only matches nodes.
  sheet.push({
    selector: 'node.hidden',
    style: {
      display: 'none',
    },
  });
  sheet.push({
    selector: 'edge.hidden',
    style: {
      display: 'none',
    },
  });

  // ---- internal contains-edge hide class (R5 Bug #1 + #2) ----
  // After a package is promoted into a Cytoscape compound parent, the visual
  // "this node lives inside that package" affordance is the dashed compound
  // border. The package -> member contains edges that the backend returns in
  // the level=struct payload become redundant — and worse, fcose treats them
  // as attractive springs that pull every member toward the centroid AND
  // repel each other, blowing the compound's bounding box up to viewport
  // size. `applyExpansion` tags any contains edge whose source is the
  // soon-to-be compound parent (and whose target lands inside it) with this
  // class so they vanish. Like the other `display: none` rules above, this
  // MUST live in the base stylesheet — Cytoscape silently drops `display:
  // none` rules added via `cy.style().selector(...).update()` for already-
  // rendered elements (see prior round notes).
  sheet.push({
    selector: 'edge.contains-internal',
    style: {
      display: 'none',
    },
  });

  // ---- collapse-driven hide class (right-click "Hide subtree" + useCollapse) ----
  // Same constraint as `.hidden` above: Cytoscape only honours `display: none`
  // when the rule is part of the base stylesheet handed to `cytoscape({...})`.
  // Adding it incrementally via `cy.style().selector('.collapsed-hidden')...`
  // is silently ignored for already-rendered elements, so the menu item
  // appeared to do nothing.
  sheet.push({
    selector: 'node.collapsed-hidden',
    style: {
      display: 'none',
    },
  });
  sheet.push({
    selector: 'edge.collapsed-hidden',
    style: {
      display: 'none',
    },
  });

  // ---- collapsed-root border (cosmetic, safe to attach incrementally too) ----
  sheet.push({
    selector: 'node.collapsed-root',
    style: {
      'border-style': 'dotted',
      'border-width': 3,
    },
  });

  return sheet;
}

/** Read the live theme tokens from `<html>` / CSS custom properties. */
export function readThemeTokens(root: HTMLElement = document.documentElement): ThemeTokens {
  const styles = window.getComputedStyle(root);
  const read = (name: string, fallback: string): string => {
    const v = styles.getPropertyValue(name).trim();
    return v !== '' ? v : fallback;
  };
  return {
    fg: read('--color-fg', '#0f172a'),
    fgMuted: read('--color-fg-muted', '#475569'),
    bg: read('--color-bg', '#ffffff'),
    bgElevated: read('--color-bg-elevated', '#f8fafc'),
    accent: read('--color-accent', '#3b82f6'),
    border: read('--color-border', '#cbd5f5'),
  };
}
