/**
 * Fully-qualified-name helpers for entry-point manipulation.
 *
 * The wire format used by the backend (`docs/api-contract.md` §2,
 * `EntryPointSpec.manual`) is `pkg#Name` for top-level functions and
 * `pkg#Type.Method` for methods. The frontend mirrors that string verbatim
 * — there is no typed object on the client because the user pastes / types
 * raw FQNs in the add-entry dialog.
 *
 * Two helpers live here:
 *
 *   - {@link isValidFqn}   syntactic validation used to disable the dialog's
 *                          submit button before it ever reaches the server;
 *   - {@link nodeToFqn}    converts a graph `Node` to the FQN the backend
 *                          recognises, so "Add as entry point" from a graph
 *                          tap can populate the manual list directly.
 */

import type { Core, NodeSingular } from 'cytoscape';

import type { Graph, Node } from '../../../api/types';

/**
 * Strict FQN regular expression.
 *
 * - package segment: import path letters / digits / `_` / `.` / `/` / `-`
 *   plus optional `@` (for `golang.org/x/tools` style internal aliases that
 *   may legitimately contain `@v0.1.0`-like markers in transitive deps).
 *   Must be non-empty.
 * - then a single `#`.
 * - then a Go identifier or `Type.Method`.
 *
 * Rejects whitespace, multiple `#`, leading/trailing dots and method names
 * starting with a digit.
 */
const FQN_PATTERN = /^[A-Za-z0-9_./@-]+#[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/**
 * Returns `true` when `value` is a syntactically valid FQN that the backend
 * is willing to attempt to resolve. Empty strings, multiple `#` separators
 * and identifier-starting digits are all rejected.
 */
export function isValidFqn(value: string): boolean {
  return FQN_PATTERN.test(value);
}

/**
 * Build the FQN that uniquely names a graph node according to the backend's
 * entry-point lookup rules. Returns `null` for nodes that cannot be entry
 * points (packages, fields, vars, consts) so the "Add as entry point"
 * affordance can hide itself instead of producing an invalid spec.
 *
 * Methods need the receiver name to round-trip. The server emits
 * `Node.name = methodName` (no receiver), so the receiver is recovered from
 * the supplied graph via the `contains` edge that points at the method node:
 * the source of that edge is the owning struct or interface. When no graph is
 * provided or the parent cannot be resolved we fall back to `pkg#methodName`,
 * which is acceptable for free functions but will be rejected by the server
 * for methods — caller should always pass `graph` when handling method nodes.
 */
export function nodeToFqn(node: Node, graph?: Graph | null): string | null {
  if (node.kind !== 'func' && node.kind !== 'method') {
    return null;
  }
  if (node.package === '' || node.name === '') {
    return null;
  }
  if (node.kind === 'method') {
    const receiver = lookupReceiverName(node, graph);
    if (receiver === null) {
      return null;
    }
    return `${node.package}#${receiver}.${node.name}`;
  }
  return `${node.package}#${node.name}`;
}

/**
 * Walk the graph's `contains` edges to find the struct/interface that owns a
 * method node and return its `Name`. Returns `null` when the parent cannot be
 * located, signalling to the caller that the FQN cannot be constructed.
 */
/**
 * Live-graph variant of {@link nodeToFqn} used by the find resolver.
 *
 * Reads node kind / package / name straight from cy `data()` and recovers the
 * method receiver by walking the `contains` edges already present in the
 * Cytoscape core, so dynamically added members (`expandStructMembers`) get
 * an FQN even before the React `graph` snapshot has been refreshed.
 *
 * Returns `null` for non-func/non-method nodes or when the receiver cannot be
 * resolved — the caller must fall back to name-only matching in that case.
 */
export function cyNodeToFqn(node: NodeSingular, cy: Core): string | null {
  const kind = String(node.data('kind') ?? '');
  if (kind !== 'func' && kind !== 'method') {
    return null;
  }
  const pkg = String(node.data('package') ?? '');
  const name = String(node.data('name') ?? '');
  if (pkg === '' || name === '') {
    return null;
  }
  if (kind === 'method') {
    const receiver = lookupReceiverNameInCy(node.id(), cy);
    if (receiver === null) {
      return null;
    }
    return `${pkg}#${receiver}.${name}`;
  }
  return `${pkg}#${name}`;
}

/** Walk cy `contains` edges to find the struct/interface owning a method. */
function lookupReceiverNameInCy(methodId: string, cy: Core): string | null {
  // `[kind = "contains"][target = "<id>"]` is the canonical selector; we use
  // the JS API instead of a string selector so escaping is not a concern when
  // the SHA1 id contains characters the selector grammar would choke on.
  let receiver: string | null = null;
  cy.edges().forEach((edge) => {
    if (receiver !== null) {
      return;
    }
    if (String(edge.data('kind') ?? '') !== 'contains') {
      return;
    }
    if (edge.target().id() !== methodId) {
      return;
    }
    const parent = edge.source();
    const pkind = String(parent.data('kind') ?? '');
    if (pkind === 'struct' || pkind === 'interface') {
      const pname = String(parent.data('name') ?? '');
      if (pname !== '') {
        receiver = pname;
      }
    }
  });
  return receiver;
}

function lookupReceiverName(node: Node, graph?: Graph | null): string | null {
  if (graph === null || graph === undefined) {
    return null;
  }
  for (const edge of graph.edges) {
    if (edge.kind !== 'contains' || edge.target !== node.id) {
      continue;
    }
    const parent = graph.nodes.find((n) => n.id === edge.source);
    if (parent === undefined) {
      continue;
    }
    if (parent.kind === 'struct' || parent.kind === 'interface') {
      return parent.name;
    }
  }
  return null;
}
