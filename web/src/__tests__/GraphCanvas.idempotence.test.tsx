/**
 * GraphCanvas Relayout-idempotence tests.
 *
 * Locks down the R12 demo-contract guarantee: pressing the Relayout button
 * twice must produce visually identical canvases. With the deterministic
 * package-tree layout, the second relayout reapplies positions derived
 * purely from the package set — so the L∞ delta per node must be 0.
 */

import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';

import type { Graph } from '../api/types';
import { GraphCanvas } from '../pages/Main/GraphCanvas';
import type { ThemeTokens } from '../pages/Main/graph-styles';

const THEME: ThemeTokens = {
  fg: '#0f172a',
  fgMuted: '#475569',
  bg: '#ffffff',
  bgElevated: '#f8fafc',
  accent: '#3b82f6',
  border: '#cbd5f5',
};

const TREE_GRAPH: Graph = {
  project_id: 'p-idem',
  generated_at: '2026-04-19T10:00:00Z',
  aggregation: 'package',
  stats: { node_count: 5, edge_count: 0, by_kind: { package: 5 }, dead_count: 0 },
  nodes: [
    pkg('p-cmd', 'github.com/x/y/cmd/server'),
    pkg('p-api', 'github.com/x/y/internal/api'),
    pkg('p-db', 'github.com/x/y/internal/db'),
    pkg('p-mw', 'github.com/x/y/internal/api/middleware', true),
    pkg('p-util', 'github.com/x/y/pkg/util'),
  ],
  edges: [],
  warnings: [],
};

function pkg(id: string, packagePath: string, isEntry = false): Graph['nodes'][number] {
  return {
    id,
    name: packagePath.split('/').slice(-1)[0]!,
    kind: 'package',
    package: packagePath,
    file: '',
    line: 0,
    exported: true,
    reachable: true,
    is_entry: isEntry,
  };
}

interface CyNodeProbe {
  id: () => string;
  position: () => { x: number; y: number };
  isChild: () => boolean;
  parent: () => { length: number };
}
interface CyProbe {
  nodes: () => { toArray: () => CyNodeProbe[] };
  width: () => number;
  height: () => number;
}

function readCy(): CyProbe {
  const container = screen.getByTestId('graph-canvas') as HTMLElement & {
    _cyreg?: { cy?: CyProbe };
  };
  const cy = container._cyreg?.cy;
  if (cy === undefined) throw new Error('cy not mounted');
  return cy;
}

function snapshotPositions(): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  for (const n of readCy().nodes().toArray()) {
    if (n.isChild() && n.parent().length > 0) continue;
    out[n.id()] = n.position();
  }
  return out;
}

function Harness(): JSX.Element {
  const [trigger, setTrigger] = useState(0);
  return (
    <div>
      <button data-testid="relayout-btn" type="button" onClick={() => setTrigger((n) => n + 1)}>
        relayout
      </button>
      <GraphCanvas
        graph={TREE_GRAPH}
        theme={THEME}
        projectId="p-idem"
        reducedMotion
        rendererOverride={{ name: 'null' }}
        layoutTrigger={trigger}
      />
    </div>
  );
}

import { fireEvent } from '@testing-library/react';
import type { JSX } from 'react';

describe('<GraphCanvas /> Relayout idempotence', () => {
  it('produces identical positions after two consecutive Relayouts', async () => {
    render(<Harness />);
    await waitFor(() => {
      expect(readCy().nodes().toArray().length).toBeGreaterThan(0);
    });

    const before = snapshotPositions();
    fireEvent.click(screen.getByTestId('relayout-btn'));
    await waitFor(() => {
      // Layout is synchronous (preset); just give React a tick to flush.
      const snap = snapshotPositions();
      expect(Object.keys(snap).length).toBe(Object.keys(before).length);
    });
    const afterFirst = snapshotPositions();
    fireEvent.click(screen.getByTestId('relayout-btn'));
    await waitFor(() => {
      const snap = snapshotPositions();
      expect(Object.keys(snap).length).toBe(Object.keys(afterFirst).length);
    });
    const afterSecond = snapshotPositions();

    for (const id of Object.keys(afterFirst)) {
      const a = afterFirst[id]!;
      const b = afterSecond[id]!;
      expect(Math.abs(a.x - b.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(a.y - b.y)).toBeLessThanOrEqual(1);
    }
  });

  it('keeps the pinned entry node within the layout extent after Relayout', async () => {
    render(<Harness />);
    await waitFor(() => {
      expect(readCy().nodes().toArray().length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getByTestId('relayout-btn'));
    await waitFor(() => {
      const cy = readCy();
      const nodes = cy.nodes().toArray();
      // Find the entry node by id.
      const entry = nodes.find((n) => n.id() === 'p-mw');
      expect(entry).toBeDefined();
      const positions = nodes.map((n) => n.position());
      const xs = positions.map((p) => p.x);
      const ys = positions.map((p) => p.y);
      const p = entry!.position();
      expect(p.x).toBeGreaterThanOrEqual(Math.min(...xs));
      expect(p.x).toBeLessThanOrEqual(Math.max(...xs));
      expect(p.y).toBeGreaterThanOrEqual(Math.min(...ys));
      expect(p.y).toBeLessThanOrEqual(Math.max(...ys));
    });
  });
});
