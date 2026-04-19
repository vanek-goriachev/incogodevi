// Package exporter renders a domain.DeadCodeReport into the wire formats
// documented in docs/api-contract.md §4 — JSON (FR-24) and TXT (FR-23).
//
// Both renderers produce a deterministic byte stream so that golden-file
// snapshots and HTTP-cache validators can rely on byte-for-byte equality of
// equal inputs. Entries are sorted by (Package, File, Line) and then by FQN
// to guarantee a stable order across runs.
package exporter
