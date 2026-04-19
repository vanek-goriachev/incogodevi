// Package orchestrator wires the analysis pipeline (parser → graph → entry →
// reach → exporter) under a single entry point and streams progress to the
// HTTP layer through an api.SSEStreamer (docs/architecture.md §3.3, §5).
//
// A single per-project mutex (lazily allocated through a sync.Map) enforces
// the ADR-10 single-flight rule: only one analysis per project_id runs at a
// time; analyses for different projects proceed in parallel.
package orchestrator
