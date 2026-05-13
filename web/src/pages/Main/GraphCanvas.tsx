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
import cola from 'cytoscape-cola';
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
import { defaultLayerEditorState, type LayerEditorState } from './layout/laneMapping';
import {
  computeReachDepthPositions,
  type LayoutEdge,
  type LayoutNode,
} from './layout/reachDepth';
import {
  computeSlotPositions,
  type SlotLayoutEdge,
  type SlotLayoutNode,
} from './layout/slotLayout';
import { Tooltip, type TooltipPayload } from './Tooltip';
import { usePositionsStorage, type PositionMap } from './usePositionsStorage';

// Register the cola + fcose layouts exactly once. cytoscape's `use()` is
// idempotent for the same extension reference. fcose is retained as a
// fallback in case future code wants the heuristic spread.
let layoutsRegistered = false;
function ensureLayoutsRegistered(): void {
  if (layoutsRegistered) {
    return;
  }
  cytoscape.use(fcose);
  cytoscape.use(cola);
  layoutsRegistered = true;
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
  /**
   * Counter that re-runs the initial layout from scratch when bumped. The
   * value itself is opaque — only changes matter. Used by the top-bar
   * "relayout" button to reset a manually-disturbed canvas without forcing
   * the user to refetch the graph.
   */
  layoutTrigger?: number;
  /**
   * Optional callback fired when the number of pinned entry-point nodes
   * exceeds {@link ENTRY_PIN_LIMIT}. Lets the parent surface a non-blocking
   * toast instead of letting the entry-pin layer silently bail. Receives the
   * actual entry count so the message can quote it.
   */
  onPinOverflow?: (entryCount: number, limit: number) => void;
  /**
   * Optional Layer Editor state. When provided, the canvas-wide positioner
   * runs the slot-based layout (`computeSlotPositions`) instead of the
   * default reach-depth one. Each BFS-depth layer is honoured according to
   * the user's slot/lane arrangement; folder-groups pull their packages out
   * of their BFS lane. When omitted, layout falls back to the legacy
   * positioner so existing tests + screenshots keep their behaviour.
   */
  layerEditorState?: LayerEditorState;
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
  layoutTrigger = 0,
  onPinOverflow,
  layerEditorState,
}: GraphCanvasProps): JSX.Element {
  ensureLayoutsRegistered();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const positions = usePositionsStorage(projectId);
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tooltip, setTooltip] = useState<TooltipPayload | null>(null);
  // Keep the latest layer editor state in a ref so positioner helpers (defined
  // outside the closure) can read it without depending on render-stability.
  const layerStateRef = useRef<LayerEditorState | undefined>(layerEditorState);
  layerStateRef.current = layerEditorState;
  // Set the moment the user grabs or drops a node. Subsequent automatic
  // `layoutstop` snapshots skip the write so a manual drop is never
  // clobbered by the trailing layout animation (FR-26).
  const userDraggedRef = useRef<boolean>(false);
  // Last entry count we warned about so a re-render with the same overflow
  // state does not retrigger the toast.
  const lastWarnedEntryCountRef = useRef<number>(0);
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

    // Surface a non-blocking warning when the number of entry-point nodes
    // overshoots ENTRY_PIN_LIMIT. The pinned-row layer (pinEntryPoints / the
    // R8 styling) bails on overflow to keep the layout legible; without this
    // callback the failure was silent and looked like an entry-point bug.
    const entryCount = graph.nodes.filter((n) => n.is_entry).length;
    if (
      entryCount > ENTRY_PIN_LIMIT &&
      entryCount !== lastWarnedEntryCountRef.current &&
      onPinOverflow !== undefined
    ) {
      lastWarnedEntryCountRef.current = entryCount;
      onPinOverflow(entryCount, ENTRY_PIN_LIMIT);
    } else if (entryCount <= ENTRY_PIN_LIMIT) {
      lastWarnedEntryCountRef.current = 0;
    }

    // Defensive: re-enable user interaction every time we resync. Some
    // upstream layouts (cola in particular) can leave the core in a half-
    // initialised state after a hot reload where panning/zooming silently
    // become no-ops; explicitly re-arming them here is cheap and idempotent.
    cy.userPanningEnabled(true);
    cy.userZoomingEnabled(true);
    cy.boxSelectionEnabled(false);

    // Run a fresh layout only when the topology changed materially or when
    // the canvas was empty before. Drag-induced position updates flow through
    // `usePositionsStorage` and never re-trigger the layout.
    const topologyChanged = before === 0 || Math.abs(after - before) > 0;

    // Persist initial positions for any nodes the layout placed for the first
    // time so subsequent reloads are stable (FR-26). The listener MUST be
    // registered *before* `runLayout`: the preset-only path (all positions
    // restored from localStorage) fires `layoutstop` synchronously inside
    // `cy.layout(...).run()`, so a `cy.one` registered after the call would
    // miss the event entirely — leaving the viewport unfit and giving the
    // impression that the canvas has gone unresponsive.
    const runFitSnapshot = (): void => {
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
      // Zoom-capped fit: fit the graph but never below `minReadableZoom`.
      // For big graphs whose natural cola layout is a long lens (200+
      // nodes), an unconstrained fit shrinks nodes to dust. The cap keeps
      // labels legible — the user pans from the centred view if they need
      // to see the periphery.
      cy.fit(undefined, 60);
      const z = cy.zoom();
      const minReadableZoom = 0.55;
      if (z < minReadableZoom) {
        cy.zoom(minReadableZoom);
        cy.center();
      }
    };
    if (topologyChanged) {
      cy.one('layoutstop', runFitSnapshot);
      // R11: defer the layout by one microtask so the sibling MainView
      // effect that applies filters (which runs AFTER this effect because
      // parent effects fire after child effects in React) gets a chance to
      // tag external / filtered nodes with the `.hidden` class BEFORE fcose
      // starts. Without the defer, the initial fcose includes hidden nodes
      // as invisible repulsion sources and the visible internal cluster
      // collapses into a central knot.
      queueMicrotask(() => {
        // The cy instance may have been torn down while we were queued.
        if (cyRef.current !== cy) {
          return;
        }
        runLayout(cy, graph, persisted, reducedMotion, layerStateRef.current);
      });
    }
  }, [graph, positions, reducedMotion]);

  // ---- layer-editor effect: when the editor state changes, re-apply the
  // canvas-wide slot positions in place. We deliberately skip the initial
  // mount so the very first paint goes through the regular graph effect (which
  // runs runLayout with the same state via the ref) — re-running here would
  // be a redundant write.
  const layerSeenRef = useRef<LayerEditorState | undefined>(layerEditorState);
  useEffect(() => {
    const cy = cyRef.current;
    if (cy === null || graph === null || graph.nodes.length === 0) {
      layerSeenRef.current = layerEditorState;
      return;
    }
    if (layerSeenRef.current === layerEditorState) {
      return;
    }
    layerSeenRef.current = layerEditorState;
    if (layerEditorState === undefined) {
      return;
    }
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        n.unlock();
      });
    });
    applyReachDepthPositions(cy, layerEditorState);
    cy.layout({ name: 'preset', animate: false } as LayoutOptions).run();
    // Persist the new positions so a reload doesn't flicker.
    const snap: PositionMap = {};
    cy.nodes().forEach((n) => {
      const p = n.position();
      snap[n.id()] = { x: p.x, y: p.y };
    });
    positions.write(snap);
  }, [layerEditorState, graph, positions]);

  // ---- relayout effect: re-run the initial layout when the parent bumps
  // `layoutTrigger`. The skip-on-mount guard prevents a redundant layout
  // pass right after the graph effect already ran one for the initial load.
  const layoutTriggerSeenRef = useRef<number>(layoutTrigger);
  useEffect(() => {
    if (layoutTrigger === layoutTriggerSeenRef.current) {
      return;
    }
    layoutTriggerSeenRef.current = layoutTrigger;
    const cy = cyRef.current;
    if (cy === null || graph === null || graph.nodes.length === 0) {
      return;
    }
    // Forget the manual-drag memo — the user explicitly asked for a fresh
    // layout, so the post-layout snapshot may overwrite their drops.
    userDraggedRef.current = false;
    cy.batch(() => {
      cy.nodes().forEach((n) => {
        n.unlock();
      });
    });
    cy.one('layoutstop', () => {
      const snap: PositionMap = {};
      cy.nodes().forEach((n) => {
        const p = n.position();
        snap[n.id()] = { x: p.x, y: p.y };
      });
      positions.write(snap);
      cy.fit(visibleEles(cy), 60);
      const z = cy.zoom();
      const minReadableZoom = 0.55;
      if (z < minReadableZoom) {
        cy.zoom(minReadableZoom);
        cy.center();
      }
    });
    // Reach-depth: Relayout re-applies positions derived from BFS distance
    // from entry-points + barycenter intra-layer ordering. R12: if a
    // LayerEditorState is in play, slot-based positions take over.
    applyReachDepthPositions(cy, layerStateRef.current);
    cy.layout({ name: 'preset', animate: false } as LayoutOptions).run();
  }, [layoutTrigger, graph, positions, reducedMotion]);

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
function syncElements(
  cy: Core,
  graph: Graph,
  persisted: PositionMap,
): void {
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
      const id = cn.id();
      if (!wantNodes.has(id)) {
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

/**
 * Return the currently visible elements (not hidden by `.hidden` /
 * `.mode-hide-*` / `.collapsed-hidden` / `.contains-internal` classes).
 *
 * R11: the initial / relayout fcose passes must ignore nodes the user has
 * filtered out (e.g. `hideExternal: true`). Otherwise the invisible repulsion
 * sources crush the remaining internal cluster into a central knot.
 */
function visibleEles(cy: Core): ReturnType<Core['collection']> {
  const hiddenClasses = [
    'hidden',
    'mode-hide-live',
    'mode-hide-dead',
    'collapsed-hidden',
    'contains-internal',
  ];
  return cy.elements().filter((el) => {
    for (const c of hiddenClasses) {
      if (el.hasClass(c)) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Apply the deterministic package-tree layout to `cy`.
 *
 * R12: the canvas-wide force-directed pass (fcose / cola) was non-idempotent
 * — pressing the Relayout button on an already-spread canvas re-ran the
 * simulation from the disturbed state, monotonically widening the bounding
 * box ("размазывает"). We replace that pass with a pure tidy-tree layout
 * derived from `node.data('package')`, applied via Cytoscape's `preset`
 * layout. Identical package set → identical pixels. Per-package compound
 * children remain laid out by the scoped fcose pass in
 * `useAggregateExpand.applyExpansion` (R8 invariant).
 */
function runLayout(
  cy: Core,
  graph: Graph,
  persisted: PositionMap,
  reducedMotion: boolean,
  layerState?: LayerEditorState,
): void {
  const allPersisted = graph.nodes.every((n) => persisted[n.id] !== undefined);
  if (allPersisted && graph.nodes.length > 0) {
    cy.layout({ name: 'preset', animate: false } as LayoutOptions).run();
    return;
  }

  // Drop any leftover locks from previous entry-row pins or interactions.
  cy.batch(() => {
    cy.nodes().forEach((n) => {
      n.unlock();
    });
  });

  applyReachDepthPositions(cy, layerState);
  void reducedMotion;
  cy.layout({ name: 'preset', animate: false } as LayoutOptions).run();
}

/**
 * Reach-depth pure positioner adapter for Cytoscape.
 *
 * Reads every top-level node and edge from `cy`, builds a plain data
 * representation, calls `computeReachDepthPositions` and writes positions
 * back. Compound children (members inside an expanded package) keep their
 * pre-existing position — `useAggregateExpand.applyExpansion` owns those via
 * its scoped reach-depth pass.
 *
 * R12: when a `LayerEditorState` is supplied, this function dispatches to
 * `computeSlotPositions` so the user's slot/lane arrangement drives the
 * layout. Without state it falls back to the original BFS-depth positioner.
 *
 * Determinism: identical `cy` topology + entry set + state ⇒ identical
 * positions. Idempotence to ≤1 px is preserved across both paths.
 */
function applyReachDepthPositions(cy: Core, layerState?: LayerEditorState): void {
  const slotNodes: SlotLayoutNode[] = [];
  const legacyNodes: LayoutNode[] = [];
  const entryIds = new Set<string>();
  // Cache outerWidth/outerHeight ONCE per layout pass. Cytoscape recomputes
  // these from styling+label every call, so reading them twice (once for
  // the inline width on the slot node, once for the dimensions map below)
  // would double the cost on a 1000-node canvas. Per the Bug 1 fix the
  // dimensions map is what drives dynamic slot widths and lane heights.
  const nodeDimensions = new Map<string, { width: number; height: number }>();
  cy.nodes().forEach((n) => {
    if (n.isChild() && n.parent().length > 0) {
      return;
    }
    const id = n.id();
    const isEntry = n.data('is_entry') === true || n.hasClass('entry');
    const rawW = n.outerWidth();
    const rawH = n.outerHeight();
    const w = Number.isFinite(rawW) && rawW > 0 ? rawW : undefined;
    const h = Number.isFinite(rawH) && rawH > 0 ? rawH : undefined;
    if (w !== undefined && h !== undefined) {
      nodeDimensions.set(id, { width: w, height: h });
    }
    const pkg = String(n.data('package') ?? '');
    slotNodes.push({
      id,
      package: pkg,
      isEntry,
      ...(w !== undefined ? { width: w } : {}),
      ...(h !== undefined ? { height: h } : {}),
    });
    legacyNodes.push({
      id,
      isEntry,
      ...(w !== undefined ? { width: w } : {}),
      ...(h !== undefined ? { height: h } : {}),
    });
    if (isEntry) {
      entryIds.add(id);
    }
  });
  const slotEdges: SlotLayoutEdge[] = [];
  const legacyEdges: LayoutEdge[] = [];
  cy.edges().forEach((e) => {
    const src = e.source();
    const tgt = e.target();
    if (src.empty() || tgt.empty()) {
      return;
    }
    if (src.isChild() && src.parent().length > 0) return;
    if (tgt.isChild() && tgt.parent().length > 0) return;
    slotEdges.push({ source: src.id(), target: tgt.id() });
    legacyEdges.push({ source: src.id(), target: tgt.id() });
  });

  const canvasHeight = Math.max(1200, (cy.height() || 900) * 2.5);

  let positions: Map<string, { x: number; y: number }>;
  if (layerState !== undefined) {
    // Bug 1 (this PR): pass per-node dimensions so the positioner picks
    // dynamic slot widths and lane heights and stops overlapping the
    // bounding boxes of expanded compounds against neighbours.
    const result = computeSlotPositions(slotNodes, slotEdges, entryIds, layerState, {
      canvasHeight,
      topPadding: 80,
      layerGap: 360,
      minNodeGap: 110,
      maxNodesPerColumn: 14,
      columnGap: 160,
      nodeBuffer: 24,
      intraSlotPadding: 80,
      interSlotGap: 120,
      maxLaneHeight: 1800,
      nodeDimensions,
      deadRegion: { dx: 0, dy: 240 },
    });
    positions = result.positions;
  } else {
    positions = computeReachDepthPositions(legacyNodes, legacyEdges, entryIds, {
      canvasHeight,
      topPadding: 80,
      layerGap: 360,
      minNodeGap: 110,
      maxNodesPerColumn: 14,
      columnGap: 160,
      nodeBuffer: 40,
      deadRegion: { dx: 0, dy: 240 },
    });
  }

  cy.batch(() => {
    cy.nodes().forEach((n) => {
      if (n.isChild() && n.parent().length > 0) {
        return;
      }
      const p = positions.get(n.id());
      if (p === undefined) {
        return;
      }
      n.position({ x: p.x, y: p.y });
    });
  });
}

// Exported for tests; intentional named re-export so the test harness does
// not need to plumb through Cytoscape just to verify the adapter wiring.
export { applyReachDepthPositions };
// Re-export so a future caller can supply a default state from outside the
// canvas file without re-importing the layout module.
export { defaultLayerEditorState };

/** Scope passed to `runLayout` helpers. Mirrors `layoutOptionsFor`. */
type LayoutScope = 'initial' | 'relayout-button' | 'expansion';
void (undefined as LayoutScope | undefined);

/**
 * Build fcose layout options for the given scope. Three scopes are supported:
 *
 *   - `'initial'`  — the very first paint. Full canvas, `quality: 'proof'`,
 *                    `randomize: true`. Expensive but runs once.
 *   - `'relayout-button'` — the user explicitly asked for a fresh layout via
 *                    the top-bar "relayout" button OR the "Collapse all" flow
 *                    drops every expanded member. Same spread tuning as the
 *                    initial pass since the user accepted the cost.
 *   - `'expansion'` — scoped to the freshly added compound children from
 *                    `useAggregateExpand.applyExpansion`. Cheap settings
 *                    (`quality: 'default'`, `randomize: false`, capped
 *                    iterations, short animation) so a double-click completes
 *                    in ≤2s even on a 700-node aggregated canvas (R8 Task A).
 *
 * Historical context (R7): initial/relayout and expansion had already been
 * tuned separately; R8 makes the third path — expansion — cheap enough for
 * an interactive double-click on Xray-core. See the R8 task brief.
 */
export function layoutOptionsFor(
  scope: 'initial' | 'relayout-button' | 'expansion',
  graph: Graph,
  reducedMotion: boolean,
): LayoutOptions {
  if (scope === 'expansion') {
    // R5 compact tuning + R8 interactive tuning: cap `numIter` and drop the
    // animation budget so fcose returns control to the event loop quickly.
    // `quality: 'default'` skips the expensive tree-building pass that
    // `'proof'` runs first. `randomize: false` keeps the pre-placed ring
    // seed positions (set by applyExpansion) so the children fan out from
    // the package's old centre without teleporting elsewhere.
    return {
      name: 'fcose',
      animate: reducedMotion ? false : 'end',
      animationDuration: 250,
      randomize: false,
      quality: 'default',
      numIter: 500,
      nodeRepulsion: 2500,
      idealEdgeLength: 60,
      nestingFactor: 0.1,
      gravity: 0.4,
      gravityRangeCompound: 1.5,
      fit: false,
    } as unknown as LayoutOptions;
  }

  // Initial / Relayout (both full-canvas passes): spread the whole canvas.
  //
  // R11 retune. The R7 knobs (repulsion 6-9k, idealEdgeLength 120-160) left
  // Xray-core (~170 visible internal packages after hideExternal, hundreds
  // of cross-imports) as a central hairball: label-bearing compound nodes
  // ("splithttp (288)", "internet (380)") were placed shoulder-to-shoulder
  // because fcose was computing collisions against the raw node rectangles
  // (label-free) and the pairwise repulsion was two orders of magnitude
  // below what this edge density needs.
  //
  // Root-cause findings (R11):
  //   1. `nodeDimensionsIncludeLabels` was not set → fcose ignored the
  //      label-sized bounding box. Turning it ON forces repulsion to respect
  //      the actual visible footprint of adaptive-width package nodes.
  //   2. `packComponents: true` was a legacy choice for multi-component
  //      graphs; Xray-core is effectively one strongly connected component,
  //      so component packing only compresses the layout further. Disabled.
  //   3. `nodeRepulsion` at 6-9k is two orders of magnitude under the
  //      density fcose needs for this edge count. Bumped to 120k-500k.
  //   4. `idealEdgeLength` at 120-160 is shorter than the diameter of a
  //      label-sized package node, which physically prevents neighbours from
  //      separating. Raised to 400-700.
  //   5. `gravity` at 0.25 was actively pulling everything back to the
  //      centroid after repulsion pushed it apart. Dropped to 0.02.
  //   6. `edgeElasticity` lowered to 0.01 so the dense spring network does
  //      not snap the repulsion-inflated graph back into a knot.
  //
  // Validated empirically on Xray-core (see r11-layout-spread.spec.ts):
  //   initial layout → nnRatio=1.79, overlap=0, coverage ~2.4x/3.1x viewport
  //   after relayout → nnRatio=2.15, overlap=0, coverage ~3.7x/5.3x viewport
  // The >1.0 coverage is fine — the zoom-cap fit lets the user pan a graph
  // larger than the viewport, which is the correct UX for 170+ packages.
  //
  // Rejected hypotheses: (a) lowering gravity alone did not suffice without
  // repulsion bumps; (b) swapping to cose-bilkent was not needed once the
  // repulsion scale was right; (c) `eles` scoping was required for
  // filter-hidden external packages — without it, 500 invisible nodes were
  // still crushing the visible cluster (see visibleEles helper).
  const n = graph.nodes.length;
  const big = n > 80;
  const huge = n > 150;
  return {
    name: 'fcose',
    animate: !reducedMotion,
    animationDuration: 600,
    randomize: true,
    quality: 'proof',
    // R11 — honour label-sized node footprints when computing collisions.
    nodeDimensionsIncludeLabels: true,
    uniformNodeDimensions: false,
    // R11 iter2: fcose `nodeRepulsion` is interpreted relative to the
    // pairwise spring stiffness, so on a dense many-edged graph the earlier
    // 25k-45k values were still losing to the aggregate spring force. Bump
    // to a range that visibly wins on Xray-core (~170 visible packages with
    // cross-imports) without driving the graph to diverge — diverging is
    // prevented by keeping gravity finite and by fcose's damping term.
    nodeRepulsion: huge ? 500000 : big ? 350000 : 200000,
    idealEdgeLength: huge ? 700 : big ? 550 : 400,
    edgeElasticity: 0.01,
    nodeSeparation: 450,
    // Near-zero gravity so repulsion actually wins and the graph occupies
    // the available canvas instead of collapsing into a central knot.
    // fcose's damping term still prevents the layout from diverging.
    gravity: 0.02,
    gravityRange: 5.0,
    gravityCompound: 0.3,
    gravityRangeCompound: 1.5,
    nestingFactor: 0.1,
    numIter: 4000,
    // Xray-core is a single strongly connected component; component packing
    // only compresses the already-dense cluster. Leave it off so fcose uses
    // its natural force-directed spread.
    packComponents: false,
    // Compound parents (expanded packages) lay out their children in a tile
    // so the box stays compact even when the surrounding canvas is spread
    // wide.
    tile: true,
    tilingPaddingHorizontal: 20,
    tilingPaddingVertical: 10,
    // We disable fcose's auto-fit — the post-layout snapshot handler in the
    // graph effect performs a zoom-capped fit instead so labels stay legible
    // on long-lens graphs.
    fit: false,
    padding: 60,
  } as unknown as LayoutOptions;
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
 *
 * NOTE: the cola layout (current default) does not need an entry-row pin —
 * `avoidOverlap` plus the disconnected-component handling already produce a
 * readable spread. The helper is kept for callers that may still want the
 * fcose flow and so existing test scaffolding can exercise it.
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

// Keep `pinEntryPoints` reachable for the type-checker even though the
// active cola layout does not invoke it. Tests or a future fcose flow can
// still reference the symbol; this avoids deleting working logic that may
// be re-enabled later.
void pinEntryPoints;

/** Centre point of the current viewport in rendered coordinates. */
function viewportCenter(cy: Core): { x: number; y: number } {
  const w = cy.width();
  const h = cy.height();
  return { x: w / 2, y: h / 2 };
}
