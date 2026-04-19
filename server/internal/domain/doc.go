// Package domain holds the analysis-pipeline data model: nodes, edges, graphs,
// status reports and the typed errors that flow between subsystems.
//
// All exported types are JSON-serialisable for the HTTP API and are registered
// with encoding/gob so they can be cached on disk by later phases of the
// pipeline. Field names on the wire follow the snake_case convention defined in
// docs/api-contract.md.
package domain
