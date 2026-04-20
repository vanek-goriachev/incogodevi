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

import type { Node } from '../../../api/types';

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
 * Method names live inside `Node.name` already in the form `Receiver.Method`
 * (see `server/internal/graph` naming) — this routine therefore does not
 * synthesise the dotted form on its own.
 */
export function nodeToFqn(node: Node): string | null {
  if (node.kind !== 'func' && node.kind !== 'method') {
    return null;
  }
  if (node.package === '' || node.name === '') {
    return null;
  }
  return `${node.package}#${node.name}`;
}
