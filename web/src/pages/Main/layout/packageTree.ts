/**
 * Deterministic package-tree layout.
 *
 * Pure function: given a list of Go package import paths (the value stored
 * in `domain.Node.Package` and surfaced on `cy.node().data('package')`),
 * return a stable `Map<packagePath, {x,y}>` of layout-space coordinates
 * arranged as a top-down tidy tree mirroring the directory hierarchy.
 *
 * Invariants:
 *   - identical input list (modulo order) produces identical output;
 *   - the function has no Cytoscape, DOM or `Math.random` dependency, so it
 *     is trivially unit-testable;
 *   - the common module-prefix shared by all packages is elided so a project
 *     rooted at `github.com/example/mod` does not stack its real tree four
 *     levels deep against the canvas edge.
 *
 * Layout strategy: classic two-pass tidy tree. Each leaf gets a horizontal
 * slot, each internal node is centred over its children. y is depth * verticalGap.
 *
 * Re-layout idempotence is enforced at the callsite by deriving positions
 * from the package set alone — `computePackageTreePositions` is the single
 * source of truth and pressing the Relayout button simply reassigns from it.
 */

export interface TreeLayoutOptions {
  /** Horizontal gap between sibling leaves (layout units). Defaults to 220. */
  horizontalGap?: number;
  /** Vertical gap between depth levels (layout units). Defaults to 180. */
  verticalGap?: number;
  /** Origin x of the layout. Defaults to 0. */
  originX?: number;
  /** Origin y of the layout. Defaults to 0. */
  originY?: number;
}

export interface Point {
  x: number;
  y: number;
}

interface TreeNode {
  /** Full original package path (only set on leaves of the directory tree). */
  pkg: string | null;
  /** Directory segment label (after common-prefix elision). */
  label: string;
  /** Sorted children, deterministic insertion order. */
  children: TreeNode[];
}

/**
 * Compute deterministic positions for each package path.
 *
 * @param pkgPaths Unique package import paths to position.
 * @param opts    Optional spacing overrides.
 * @returns       Map keyed by the original package path string.
 */
export function computePackageTreePositions(
  pkgPaths: readonly string[],
  opts: TreeLayoutOptions = {},
): Map<string, Point> {
  const out = new Map<string, Point>();
  if (pkgPaths.length === 0) {
    return out;
  }

  const horizontalGap = opts.horizontalGap ?? 220;
  const verticalGap = opts.verticalGap ?? 180;
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;

  // Stable sort + dedupe so different input orderings produce identical trees.
  const uniqueSorted = Array.from(new Set(pkgPaths.filter((p) => p.length > 0))).sort();
  if (uniqueSorted.length === 0) {
    return out;
  }

  // Split into segments and elide the longest common directory prefix shared
  // by every input. For `github.com/x/y/internal/api` & `github.com/x/y/cmd`
  // we drop `github.com/x/y` and root the tree at `internal` & `cmd`.
  const split = uniqueSorted.map((p) => p.split('/').filter((s) => s.length > 0));
  let commonPrefix = 0;
  if (split.length === 1) {
    // Single package — keep only its terminal segment so it sits at the origin.
    commonPrefix = Math.max(0, split[0]!.length - 1);
  } else {
    outer: for (;;) {
      const segAt = split[0]?.[commonPrefix];
      if (segAt === undefined) {
        break;
      }
      for (let i = 1; i < split.length; i += 1) {
        if (split[i]![commonPrefix] !== segAt) {
          break outer;
        }
      }
      // Never strip the final segment of the shortest path — at least one
      // segment must remain for it to anchor as a leaf.
      const minLen = Math.min(...split.map((s) => s.length));
      if (commonPrefix + 1 >= minLen) {
        break;
      }
      commonPrefix += 1;
    }
  }

  // Build the tree, inserting in lexicographic order (uniqueSorted is sorted)
  // so sibling order is deterministic.
  const root: TreeNode = { pkg: null, label: '<root>', children: [] };
  for (let i = 0; i < uniqueSorted.length; i += 1) {
    const segments = split[i]!.slice(commonPrefix);
    if (segments.length === 0) {
      // After elision the path collapses to root; attach as a virtual leaf.
      root.pkg = uniqueSorted[i]!;
      continue;
    }
    let cur = root;
    for (let d = 0; d < segments.length; d += 1) {
      const seg = segments[d]!;
      let child = cur.children.find((c) => c.label === seg);
      if (child === undefined) {
        child = { pkg: null, label: seg, children: [] };
        cur.children.push(child);
      }
      cur = child;
    }
    cur.pkg = uniqueSorted[i]!;
  }

  // Tidy-tree pass: each leaf gets a slot; each internal node centres over
  // its children.
  let leafCounter = 0;
  const layout = (node: TreeNode, depth: number): { x: number; y: number } => {
    const y = originY + depth * verticalGap;
    if (node.children.length === 0) {
      const x = originX + leafCounter * horizontalGap;
      leafCounter += 1;
      if (node.pkg !== null) {
        out.set(node.pkg, { x, y });
      }
      return { x, y };
    }
    let minX = Infinity;
    let maxX = -Infinity;
    for (const child of node.children) {
      const p = layout(child, depth + 1);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
    }
    const x = (minX + maxX) / 2;
    if (node.pkg !== null) {
      // The node is both a directory and a real package (e.g. `internal`
      // exists as a package itself). Anchor it at the centre of its children
      // but at the parent's depth so it does not overlap them.
      out.set(node.pkg, { x, y });
    }
    return { x, y };
  };

  if (root.children.length === 0) {
    // All packages collapsed to root after prefix elision (degenerate case).
    if (root.pkg !== null) {
      out.set(root.pkg, { x: originX, y: originY });
    }
    return out;
  }
  // Root itself is virtual unless every package collapsed there. Lay out each
  // top-level child as a subtree starting at depth 0.
  for (const child of root.children) {
    layout(child, 0);
  }
  // If a package collapsed to the root, place it above the canvas.
  if (root.pkg !== null) {
    const xs = Array.from(out.values()).map((p) => p.x);
    const cx = xs.length === 0 ? originX : (Math.min(...xs) + Math.max(...xs)) / 2;
    out.set(root.pkg, { x: cx, y: originY - verticalGap });
  }
  return out;
}
