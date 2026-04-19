// Package api wires the HTTP layer of the Go Dependencies Visualizer.
//
// It exposes a Server type built on top of net/http.ServeMux with method-based
// routing (Go 1.22+). The router is wrapped with a small middleware chain
// (panic recovery, request id, structured access log, same-origin CORS) and
// returns errors using the canonical envelope from docs/api-contract.md §0.
//
// All analysis endpoints (/api/projects, /analyze, /graph, /dead-code) are
// implemented in this package; later tasks layer on the SPA and CLI tooling.
package api
