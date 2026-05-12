/**
 * Right-rail "Legend" panel (R4-9).
 *
 * Static, theme-aware key for the eight node kinds and six edge kinds the
 * dependency graph renders. Mirrors the swatches/colours from
 * `graph-styles.ts` so the user can map a shape/colour on the canvas back
 * to its semantic kind without leaving the page.
 *
 * Wrapped in a `<details>` so it stays out of the way until the user
 * actively asks for a key.
 */

import type { JSX } from 'react';

import {
  ALL_EDGE_KINDS,
  ALL_NODE_KINDS,
  type EdgeKind,
  type NodeKind,
} from '../../../api/types';
import {
  EDGE_KIND_STYLES,
  NODE_KIND_STYLES,
  type EdgeKindStyle,
  type NodeKindStyle,
} from '../graph-styles';
import './LegendPanel.css';

const NODE_LABELS: Readonly<Record<NodeKind, string>> = {
  package: 'Package',
  struct: 'Struct',
  interface: 'Interface',
  func: 'Function',
  method: 'Method',
  field: 'Field',
  var: 'Var',
  const: 'Const',
};

const EDGE_LABELS: Readonly<Record<EdgeKind, string>> = {
  imports: 'imports',
  contains: 'contains',
  calls: 'calls',
  embeds: 'embeds',
  implements: 'implements',
  references: 'references',
};

const NODE_DESCRIPTIONS: Readonly<Record<NodeKind, string>> = {
  package: 'Aggregated container; double-click to expand.',
  struct: 'Concrete type with fields and methods.',
  interface: 'Method-set contract; dashed implements arrows point at it.',
  func: 'Top-level function (package-scoped).',
  method: 'Function bound to a struct or interface receiver.',
  field: 'Struct field declaration.',
  var: 'Package-level variable.',
  const: 'Package-level constant.',
};

const EDGE_DESCRIPTIONS: Readonly<Record<EdgeKind, string>> = {
  imports: 'Cross-package import (aggregated view only).',
  contains: 'Parent owns child (package -> struct, struct -> field).',
  calls: 'Caller invokes callee (function-call graph).',
  embeds: 'Struct/interface embedding.',
  implements: 'Type satisfies an interface (bidirectional in reach).',
  references: 'Symbol referenced without being called.',
};

export function LegendPanel(): JSX.Element {
  return (
    <details
      className="legend-panel"
      data-testid="legend-panel"
    >
      <summary className="legend-panel__summary">Legend</summary>

      <section className="legend-panel__section" aria-label="Node kinds">
        <h4 className="legend-panel__section-title">Nodes</h4>
        <ul className="legend-panel__list" data-testid="legend-nodes">
          {ALL_NODE_KINDS.map((kind) => {
            const style = NODE_KIND_STYLES[kind];
            return (
              <li key={kind} className="legend-panel__row">
                <NodeSwatch style={style} />
                <span className="legend-panel__label">{NODE_LABELS[kind]}</span>
                <span className="legend-panel__hint">
                  {NODE_DESCRIPTIONS[kind]}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="legend-panel__section" aria-label="Edge kinds">
        <h4 className="legend-panel__section-title">Edges</h4>
        <ul className="legend-panel__list" data-testid="legend-edges">
          {ALL_EDGE_KINDS.map((kind) => {
            const style = EDGE_KIND_STYLES[kind];
            return (
              <li key={kind} className="legend-panel__row">
                <EdgeSwatch style={style} />
                <span className="legend-panel__label">{EDGE_LABELS[kind]}</span>
                <span className="legend-panel__hint">
                  {EDGE_DESCRIPTIONS[kind]}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="legend-panel__section" aria-label="State markers">
        <h4 className="legend-panel__section-title">Markers</h4>
        <ul className="legend-panel__list" data-testid="legend-markers">
          <li className="legend-panel__row">
            <span
              className="legend-panel__swatch legend-panel__swatch--marker"
              style={{
                background: '#fef3c7',
                borderColor: '#b45309',
                borderStyle: 'dashed',
                borderWidth: 2,
              }}
              aria-hidden="true"
            />
            <span className="legend-panel__label">Dead / fully-dead</span>
            <span className="legend-panel__hint">
              Unreachable from the entry set.
            </span>
          </li>
          <li className="legend-panel__row">
            <span
              className="legend-panel__swatch legend-panel__swatch--marker"
              style={{
                background: '#dbeafe',
                borderColor: '#b45309',
                borderStyle: 'dashed',
                borderWidth: 2,
              }}
              aria-hidden="true"
            />
            <span className="legend-panel__label">Partial-dead pkg</span>
            <span className="legend-panel__hint">
              Some — but not all — children are dead.
            </span>
          </li>
          <li className="legend-panel__row">
            <span
              className="legend-panel__swatch legend-panel__swatch--marker"
              style={{
                background: '#ffffff',
                borderColor: '#0f172a',
                borderStyle: 'double',
                borderWidth: 3,
              }}
              aria-hidden="true"
            />
            <span className="legend-panel__label">Entry point</span>
            <span className="legend-panel__hint">
              Seed node for the reachability BFS.
            </span>
          </li>
        </ul>
      </section>
    </details>
  );
}

function NodeSwatch({ style }: { style: NodeKindStyle }): JSX.Element {
  // Approximate the cytoscape shape with a CSS shape so the legend reads
  // visually similar without dragging in the canvas renderer. Shapes that
  // CSS can't render exactly (hexagon) fall back to a rounded rectangle —
  // the colour pair carries the bulk of the recognition load.
  const baseStyle: React.CSSProperties = {
    backgroundColor: style.fill,
    borderColor: style.border,
    borderWidth: Math.max(1, style.borderWidth),
  };
  let extra: React.CSSProperties;
  switch (style.shape) {
    case 'rectangle':
      extra = { borderRadius: 0 };
      break;
    case 'round-rectangle':
      extra = { borderRadius: 4 };
      break;
    case 'diamond':
      extra = { borderRadius: 0, transform: 'rotate(45deg) scale(0.78)' };
      break;
    case 'ellipse':
      extra = { borderRadius: '50%' };
      break;
    case 'hexagon':
      extra = { borderRadius: 4 };
      break;
    default:
      extra = { borderRadius: 4 };
  }
  return (
    <span
      aria-hidden="true"
      className="legend-panel__swatch legend-panel__swatch--node"
      style={{ ...baseStyle, ...extra }}
    />
  );
}

function EdgeSwatch({ style }: { style: EdgeKindStyle }): JSX.Element {
  // Two-tone svg: a coloured line in the middle of a square, with the line
  // style and arrow head matching the canvas rendering.
  const arrow = style.arrow !== 'none';
  return (
    <svg
      aria-hidden="true"
      className="legend-panel__swatch legend-panel__swatch--edge"
      viewBox="0 0 24 12"
    >
      {arrow ? (
        <defs>
          <marker
            id={`legend-arrow-${style.color}`}
            markerWidth="6"
            markerHeight="6"
            refX="5"
            refY="3"
            orient="auto"
          >
            <path d="M0,0 L6,3 L0,6 Z" fill={style.color} />
          </marker>
        </defs>
      ) : null}
      <line
        x1="2"
        y1="6"
        x2="22"
        y2="6"
        stroke={style.color}
        strokeWidth={Math.max(1.2, style.width)}
        strokeDasharray={
          style.lineStyle === 'dashed'
            ? '4 3'
            : style.lineStyle === 'dotted'
              ? '1.5 2'
              : undefined
        }
        markerEnd={arrow ? `url(#legend-arrow-${style.color})` : undefined}
      />
    </svg>
  );
}
