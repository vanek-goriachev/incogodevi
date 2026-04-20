/**
 * Hover tooltip rendered above the Cytoscape canvas (FR-17).
 *
 * Position is supplied in CSS pixels relative to the canvas container; the
 * caller is responsible for showing/hiding the tooltip after the design.md
 * §4 hover delay (≥ 300 ms). The component itself is intentionally dumb —
 * it owns no state and no `setTimeout`, which keeps testing trivial.
 */

import type { CSSProperties, JSX } from 'react';

import type { Node } from '../../api/types';

export interface TooltipPayload {
  node: Pick<Node, 'kind' | 'name' | 'package' | 'file' | 'line'>;
  /** CSS pixels from the canvas container's top-left corner. */
  x: number;
  y: number;
}

export interface TooltipProps {
  payload: TooltipPayload | null;
}

/** Renders the tooltip when `payload` is non-null; renders nothing otherwise. */
export function Tooltip({ payload }: TooltipProps): JSX.Element | null {
  if (payload === null) {
    return null;
  }
  const { node, x, y } = payload;
  const style: CSSProperties = {
    transform: `translate(${String(x + 12)}px, ${String(y + 12)}px)`,
  };
  const fileLine = node.file !== '' ? `${node.file}:${String(node.line)}` : '\u2014';
  return (
    <div
      className="graph-tooltip"
      role="tooltip"
      data-testid="graph-tooltip"
      style={style}
    >
      <div className="graph-tooltip__row graph-tooltip__row--head">
        <span className="graph-tooltip__kind" data-testid="graph-tooltip-kind">
          {node.kind}
        </span>
        <span className="graph-tooltip__name" data-testid="graph-tooltip-name">
          {node.name}
        </span>
      </div>
      <div className="graph-tooltip__row" data-testid="graph-tooltip-package">
        {node.package}
      </div>
      <div className="graph-tooltip__row graph-tooltip__row--mono" data-testid="graph-tooltip-file">
        {fileLine}
      </div>
    </div>
  );
}
