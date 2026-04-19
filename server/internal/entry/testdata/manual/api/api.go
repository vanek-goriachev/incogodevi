// Package api carries a free function and a struct with one method so the
// manual entry-point resolver can exercise both branches.
package api

// Handler bundles per-request state.
type Handler struct {
	Name string
}

// Serve answers a request.
func (h *Handler) Serve() string { return h.Name }

// Run is a free function.
func Run() string { return "run" }
