/**
 * Cytoscape-backed dependency graph canvas.
 *
 * Owns a single `cytoscape.Core` instance for the lifetime of the component.
 * Subsequent prop changes (`graph`, `theme`, `selectedId`) are translated to
 * imperative `cy.batch(...)` calls instead of teardown+rebuild — this is
 * what keeps the runtime within the NFR-03 100 ms response budget when the
 * theme switches or a single node moves.
 *
 * Layout strategy (design.md §5.4):
 *   1. If a per-node position was persisted in localStorage, restore it.
 *   2. Otherwise pin entry-point nodes to a horizontal row centred on the
 *      layout origin (≤ 12 of them) and let the fcose plugin lay out the
 *      rest around them. After the layout settles we `cy.fit()` so the
 *      whole graph is visible without manual panning.
 *   3. Past 12 entry-point nodes, fall back to a plain fcose run — the row
 *      becomes too crowded to be useful.
 *
 * Hover tooltips (FR-17) trigger after a 300 ms dwell on a single node.
 */

import cytoscape, {
  type Core,
  type ElementDefinition,
  type EventObject,
  type LayoutOptions,
  type NodeSingular,
  type StylesheetStyle,
} from 'cytoscape';
import fcose from 'cytoscape-fcose';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import type { Edge, Graph, Node } from '../../api/types';
import { buildStylesheet, type ThemeTokens } from './graph-styles';
import { Tooltip, type TooltipPayload } from './Tooltip';
import { usePositionsStorage, type PositionMap } from './usePositionsStorage';

// Register the fcose layout exactly once. cytoscape's `use()` is idempotent
// for the same extension reference.
let fcoseRegistered = false;
function ensureFcoseRegistered(): void {
  if (fcoseRegistered) {
    return;
  }
  cytoscape.use(fcose);
  fcoseRegistered = true;
}

/** Maximum number of entry-point nodes pinned to the top row. */
export const ENTRY_PIN_LIMIT = 12;
/**
 * Horizontal step (in layout coordinates) between adjacent pinned entry
 * nodes. Independent of viewport extent because `packComponents: true` makes
 * fcose ignore any pre-layout extent estimate we might compute (T20 fix).
 */
const ENTRY_ROW_STEP = 220;
/** Tooltip dwell time (FR-17). */
const TOOLTIP_DELAY_MS = 300;

export interface GraphCanvasProps {
  /** Graph snapshot to render. `null` shows the empty state. */
  graph: Graph | null;
  /** Theme tokens — re-applied to Cytoscape on change without resetting layout. */
  theme: ThemeTokens;
  /** Project id used to scope the persisted position map. */
  projectId: string | undefined;
  /** Reduce-motion preference; disables layout animations when `true`. */
  reducedMotion: boolean;
  /** Optional override of the loading / refresh indicator. */
  loading?: boolean;
  /** Optional override of the empty-state message (filters hid everything). */
  emptyMessage?: string;
  /** Callback fired when a node is `tap`-clicked. */
  onSelectNode?: (nodeId: string | null) => void;
  /** Currently selected node id (for the right-hand info panel). */
  selectedNodeId?: string | null;
  /**
   * Cytoscape renderer override. `null` (default) selects the canvas renderer
   * shipped by Cytoscape; tests pass `{ name: 'null' }` to opt out of canvas
   * because jsdom does not implement `HTMLCanvasElement.getContext('2d')`.
   */
  rendererOverride?: { name: string } | null;
  /**
   * Invoked once the Cytoscape `Core` instance is mounted, and again with
   * `null` on unmount. Lets parent components (e.g. the filter panel) feed
   * imperative side effects through the live graph without resorting to
   * DOM-level peek at `_cyreg`.
   */
  onCyReady?: (cy: Core | null) => void;
}

/**
 * Mounts Cytoscape on a `<div>` and synchronises its elements with `graph`.
 */
export function GraphCanvas({
  graph,
  theme,
  projectId,
  reducedMotion,
  loading = false,
  emptyMessage = 'no nodes',
  onSelectNode,
  selectedNodeId = null,
  rendererOverride = null,
  onCyReady,
}: GraphCanvasProps): JSX.Element {
  ensureFcoseRegistered();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const positions = usePositionsStorage(projectId);
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tooltip, setTooltip] = useState<TooltipPayload | null>(null);
  // Set the moment the user grabs or drops a node. Subsequent automatic
  // `layoutstop` snapshots skip the write so a manual drop is never
  // clobbered by the trailing layout animation (FR-26).
  const userDraggedRef = useRef<boolean>(false);
  // Reset the "user dragged" memo when we switch projects, otherwise the
  // very first layout for a fresh project would silently skip its snapshot.
  useEffect(() => {
    userDraggedRef.current = false;
  }, [projectId]);

  // Mount + unmount the Cytoscape instance once per component lifetime. The
  // initial stylesheet is supplied here; subsequent theme changes are merged
  // via a separate effect (§ "theme effect" below) to avoid disposing the
  // graph when the user toggles dark mode.
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return undefined;
    }
    const cyOptions: cytoscape.CytoscapeOptions = {
      container,
      elements: [],
      style: buildStylesheet(theme) as unknown as StylesheetStyle[],
      layout: { name: 'preset' },
      wheelSensitivity: 0.2,
      minZoom: 0.1,
      maxZoom: 4,
      pixelRatio: 'auto',
    };
    if (rendererOverride !== null) {
      (cyOptions as unknown as { renderer: { name: string } }).renderer = rendererOverride;
    }
    const cy = cytoscape(cyOptions);
    cyRef.current = cy;
    if (onCyReady !== undefined) {
      onCyReady(cy);
    }

    return () => {
      if (onCyReady !== undefined) {
        onCyReady(null);
      }
      cy.destroy();
      cyRef.current = null;
    };
    // Theme is intentionally excluded — see theme effect below. `onCyReady`
    // is also excluded because consumers wrap it in `useCallback`; re-mounting
    // Cytoscape on every callback identity change would defeat its purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- theme effect: replace style without resetting layout/selection ----
  useEffect(() => {
    const cy = cyRef.current;
    if (cy === null) {
      return;
    }
    const sheet = buildStylesheet(theme);
    // `Style.fromJson(sheet).update()` is the official escape hatch for live
    // re-styling. It diffs selectors and keeps positions/selection intact.
    const styleApi = cy.style();
    if (typeof (styleApi as unknown as { fromJson?: unknown }).fromJson === 'function') {
      (styleApi as unknown as { fromJson: (s: StylesheetStyle[]) => { update: () => void } })
        .fromJson(sheet)
        .update();
    } else {
      cy.style(sheet as unknown as StylesheetStyle[]);
    }
  }, [theme]);

  // ---- selection effect: external `selectedNodeId` mirrors into Cytoscape ----
  useEffect(() => {
    const cy = cyRef.current;
    if (cy === null) {
      return;
    }
    cy.batch(() => {
      cy.elements().unselect();
      if (selectedNodeId !== null && selectedNodeId !== '') {
        cy.$id(selectedNodeId).select();
      }
    });
  }, [selectedNodeId]);

  // ---- graph effect: diff nodes/edges and re-layout when needed ----
  useEffect(() => {
    const cy = cyRef.current;
    if (cy === null) {
      return;
    }
    if (graph === null) {
      cy.elements().remove();
      return;
    }
    const persisted = positions.read();
    const before = cy.nodes().length;
    syncElements(cy, graph, persisted);
    const after = cy.nodes().length;

    // Run a fresh layout only when the topology changed materially or when
    // the canvas was empty before. Drag-induced position updates flow through
    // `usePositionsStorage` and never re-trigger the layout.
    const topologyChanged = before === 0 || Math.abs(after - before) > 0;
    if (topologyChanged) {
      runLayout(cy, graph, persisted, reducedMotion);
    }
    // Persist initial positions for any nodes the layout placed for the first
    // time so subsequent reloads are stable (FR-26).
    cy.one('layoutstop', () => {
      // If the user grabbed a node mid-animation, the layout's final
      // positions are stale relative to their drop. Skip the snapshot and
      // let `handleDragFree` own the persisted state.
      if (userDraggedRef.current) {
        return;
      }
      const snap: PositionMap = {};
      cy.nodes().forEach((n) => {
        const p = n.position();
        snap[n.id()] = { x: p.x, y: p.y };
      });
      positions.write(snap);
      // Auto-fit so the freshly produced layout is fully visible. Skipped
      // when the user has interacted with the graph to respect their pan/zoom.
      cy.fit(undefined, 40);
    });
  }, [graph, positions, reducedMotion]);

  // ---- interaction effect: tap, drag-end, hover ----
  useEffect(() => {
    const cy = cyRef.current;
    if (cy === null) {
      return undefined;
    }

    const handleTapNode = (evt: EventObject): void => {
      const node = evt.target as NodeSingular;
      if (onSelectNode !== undefined) {
        onSelectNode(node.id());
      }
    };
    const handleTapBackground = (evt: EventObject): void => {
      if (evt.target !== cy) {
        return;
      }
      if (onSelectNode !== undefined) {
        onSelectNode(null);
      }
    };
    const handleDragFree = (): void => {
      userDraggedRef.current = true;
      const snap: PositionMap = {};
      cy.nodes().forEach((n) => {
        const p = n.position();
        snap[n.id()] = { x: p.x, y: p.y };
      });
      positions.write(snap);
    };
    const handleGrab = (): void => {
      // The user is starting to drag — block any in-flight layout snapshot
      // from clobbering whatever they are about to do.
      userDraggedRef.current = true;
    };
    const handleMouseOver = (evt: EventObject): void => {
      const node = evt.target as NodeSingular;
      if (tooltipTimerRef.current !== null) {
        clearTimeout(tooltipTimerRef.current);
      }
      tooltipTimerRef.current = setTimeout(() => {
        const data = node.data() as Node;
        const renderedPos = node.renderedPosition();
        setTooltip({
          node: {
            kind: data.kind,
            name: data.name,
            package: data.package,
            file: data.file,
            line: data.line,
          },
          x: renderedPos.x,
          y: renderedPos.y,
        });
      }, TOOLTIP_DELAY_MS);
    };
    const handleMouseOut = (): void => {
      if (tooltipTimerRef.current !== null) {
        clearTimeout(tooltipTimerRef.current);
        tooltipTimerRef.current = null;
      }
      setTooltip(null);
    };

    cy.on('tap', 'node', handleTapNode);
    cy.on('tap', handleTapBackground);
    cy.on('grab', 'node', handleGrab);
    cy.on('free', 'node', handleDragFree);
    cy.on('dragfree', 'node', handleDragFree);
    cy.on('mouseover', 'node', handleMouseOver);
    cy.on('mouseout', 'node', handleMouseOut);

    return () => {
      cy.off('tap', 'node', handleTapNode);
      cy.off('tap', handleTapBackground);
      cy.off('grab', 'node', handleGrab);
      cy.off('free', 'node', handleDragFree);
      cy.off('dragfree', 'node', handleDragFree);
      cy.off('mouseover', 'node', handleMouseOver);
      cy.off('mouseout', 'node', handleMouseOut);
      if (tooltipTimerRef.current !== null) {
        clearTimeout(tooltipTimerRef.current);
        tooltipTimerRef.current = null;
      }
    };
  }, [onSelectNode, positions]);

  // ---- keyboard shortcuts: f = fit, +/- = zoom (when canvas focused) ----
  const handleKeyDown = useCallback((evt: ReactKeyboardEvent<HTMLDivElement>) => {
    const cy = cyRef.current;
    if (cy === null) {
      return;
    }
    if (evt.key === 'f' || evt.key === 'F') {
      cy.fit(undefined, 32);
      evt.preventDefault();
      return;
    }
    if (evt.key === '+' || evt.key === '=') {
      cy.zoom({ level: cy.zoom() * 1.2, renderedPosition: viewportCenter(cy) });
      evt.preventDefault();
      return;
    }
    if (evt.key === '-' || evt.key === '_') {
      cy.zoom({ level: cy.zoom() / 1.2, renderedPosition: viewportCenter(cy) });
      evt.preventDefault();
    }
  }, []);

  const isEmpty = graph !== null && graph.nodes.length === 0;
  const ariaLabel = useMemo<string>(() => {
    if (graph === null) {
      return 'Dependency graph';
    }
    return `Dependency graph, ${String(graph.nodes.length)} nodes, ${String(graph.edges.length)} edges`;
  }, [graph]);

  return (
    <div className="graph-canvas" data-testid="graph-canvas-root">
      <div
        ref={containerRef}
        className="graph-canvas__cy"
        data-testid="graph-canvas"
        role="application"
        aria-label={ariaLabel}
        tabIndex={0}
        onKeyDown={handleKeyDown}
      />
      <Tooltip payload={tooltip} />
      {loading ? (
        <div className="graph-canvas__refresh" data-testid="graph-canvas-refresh">
          {'refreshing\u2026'}
        </div>
      ) : null}
      {isEmpty ? (
        <div className="graph-canvas__empty" data-testid="graph-canvas-empty">
          {emptyMessage}
        </div>
      ) : null}
    </div>
  );
}

/** Diff-and-apply helper: ensures `cy` matches the graph snapshot. */
function syncElements(cy: Core, graph: Graph, persisted: PositionMap): void {
  const wantNodes = new Map<string, Node>();
  const wantEdges = new Map<string, Edge>();
  for (const n of graph.nodes) {
    wantNodes.set(n.id, n);
  }
  for (const e of graph.edges) {
    wantEdges.set(e.id, e);
  }

  cy.batch(() => {
    // Remove stale elements first to free their ids before insertion.
    cy.nodes().forEach((cn) => {
      if (!wantNodes.has(cn.id())) {
        cn.remove();
      }
    });
    cy.edges().forEach((ce) => {
      if (!wantEdges.has(ce.id())) {
        ce.remove();
      }
    });

    const additions: ElementDefinition[] = [];
    for (const node of wantNodes.values()) {
      const data = enrichNodeData(node);
      const existing = cy.$id(node.id);
      if (existing.nonempty()) {
        existing.data(data);
        toggleClass(existing, 'dead', !node.reachable);
        toggleClass(existing, 'entry', node.is_entry);
        continue;
      }
      const def: ElementDefinition = {
        group: 'nodes',
        data,
        classes: classesFor(node),
      };
      const persistedPos = persisted[node.id];
      if (persistedPos !== undefined) {
        def.position = { x: persistedPos.x, y: persistedPos.y };
      }
      additions.push(def);
    }
    for (const edge of wantEdges.values()) {
      const existing = cy.$id(edge.id);
      if (existing.nonempty()) {
        existing.data(edge as unknown as Record<string, unknown>);
        continue;
      }
      additions.push({
        group: 'edges',
        data: edge as unknown as Record<string, unknown>,
      });
    }
    if (additions.length > 0) {
      cy.add(additions);
    }
  });
}

/**
 * Mirror the API node into the shape Cytoscape stores on an element. The
 * only enrichment is `display_label`, which the package-aggregated stylesheet
 * reads when `child_count` is present so the badge reads `<name> (count)`.
 */
function enrichNodeData(node: Node): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(node as unknown as Record<string, unknown>) };
  if (node.kind === 'package' && typeof node.child_count === 'number' && node.child_count > 0) {
    out['display_label'] = `${node.name} (${String(node.child_count)})`;
  }
  return out;
}

/** Compute the list of CSS classes attached to a node. */
function classesFor(node: Node): string {
  const classes: string[] = [];
  if (!node.reachable) {
    classes.push('dead');
  }
  if (node.is_entry) {
    classes.push('entry');
  }
  return classes.join(' ');
}

/** Add or remove a single class without disturbing the others. */
function toggleClass(node: NodeSingular, className: string, on: boolean): void {
  if (on) {
    node.addClass(className);
  } else {
    node.removeClass(className);
  }
}

/** Run the appropriate Cytoscape layout for the current graph snapshot. */
function runLayout(
  cy: Core,
  graph: Graph,
  persisted: PositionMap,
  reducedMotion: boolean,
): void {
  const allPersisted = graph.nodes.every((n) => persisted[n.id] !== undefined);
  if (allPersisted && graph.nodes.length > 0) {
    cy.layout({ name: 'preset', animate: false } as LayoutOptions).run();
    return;
  }

  pinEntryPoints(cy, graph);

  const baseLayoutOpts = {
    name: 'fcose',
    randomize: true,
    quality: 'proof',
    nodeRepulsion: 12000,
    idealEdgeLength: 180,
    nodeSeparation: 80,
    padding: 40,
    packComponents: true,
    nodeDimensionsIncludeLabels: true,
    tile: true,
    fit: true,
  };
  const layoutOpts: LayoutOptions = reducedMotion
    ? ({ ...baseLayoutOpts, animate: false } as unknown as LayoutOptions)
    : ({ ...baseLayoutOpts, animate: 'end', animationDuration: 400 } as unknown as LayoutOptions);
  cy.layout(layoutOpts).run();
}

/**
 * Pin entry-point nodes to a horizontal row centred on the layout origin.
 *
 * Uses fixed `ENTRY_ROW_STEP` spacing in layout coordinates rather than
 * `cy.extent()`. On a freshly mounted Cytoscape instance the extent is
 * degenerate, and after we enabled `packComponents: true` fcose ignores any
 * extent-derived row even when it isn't degenerate — so the row was both
 * cramped and ignored. Fixed spacing keeps the entry row readable and lets
 * the subsequent `cy.fit()` re-frame everything together.
 */
function pinEntryPoints(cy: Core, graph: Graph): void {
  const entryNodes = graph.nodes.filter((n) => n.is_entry);
  cy.batch(() => {
    cy.nodes().forEach((n) => {
      n.unlock();
    });
  });
  if (entryNodes.length === 0 || entryNodes.length > ENTRY_PIN_LIMIT) {
    return;
  }
  const totalWidth = (entryNodes.length - 1) * ENTRY_ROW_STEP;
  const x0 = -totalWidth / 2;
  cy.batch(() => {
    entryNodes.forEach((node, idx) => {
      const cyNode = cy.$id(node.id);
      if (cyNode.empty()) {
        return;
      }
      cyNode.position({ x: x0 + idx * ENTRY_ROW_STEP, y: 0 });
      cyNode.lock();
    });
  });
}

/** Centre point of the current viewport in rendered coordinates. */
function viewportCenter(cy: Core): { x: number; y: number } {
  const w = cy.width();
  const h = cy.height();
  return { x: w / 2, y: h / 2 };
}
