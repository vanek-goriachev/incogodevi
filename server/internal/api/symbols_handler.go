package api

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// symbolEntry is a single row of the flat symbol catalogue returned by
// GET /api/projects/{id}/symbols. It carries the receiver-aware FQN the
// loader accepts so the frontend's entry-point picker can submit it
// verbatim without rebuilding the canonical form locally.
//
// FQN format mirrors entry.parseManualFQN (server/internal/entry/resolver.go):
//
//   - "<pkg>#<Name>"            for top-level funcs / vars / consts / types
//   - "<pkg>#<Type>.<Method>"   for methods (receiver recovered via the
//     `contains` edge that points at the method node).
//
// Only func/method/struct/interface symbols are emitted: the picker is
// scoped to entry-point candidates plus the types a user might pin via
// interface-impl. Package, field, var and const symbols are skipped on
// purpose to keep the dropdown signal-to-noise high.
type symbolEntry struct {
	ID      string          `json:"id"`
	Name    string          `json:"name"`
	FQN     string          `json:"fqn"`
	Kind    domain.NodeKind `json:"kind"`
	Package string          `json:"package"`
}

// symbolsResponse is the JSON envelope of GET /api/projects/{id}/symbols.
type symbolsResponse struct {
	ProjectID   domain.ProjectID `json:"project_id"`
	GeneratedAt time.Time        `json:"generated_at"`
	Count       int              `json:"count"`
	Symbols     []symbolEntry    `json:"symbols"`
}

// handleSymbols implements GET /api/projects/{id}/symbols.
//
// It reads the cached graph and emits every func/method/struct/interface
// symbol with the receiver-aware FQN entry.parseManualFQN expects. The
// frontend's entry-point combobox consumes this list to offer typo-free
// autocomplete instead of forcing the user to memorise canonical FQNs.
//
// The endpoint is read-only and never mutates the cached graph; it always
// emits every symbol (reachable or not) so the user can pin entries inside
// currently-collapsed packages.
func (s *Server) handleSymbols(w http.ResponseWriter, r *http.Request) {
	rawID := r.PathValue("id")
	id, err := asProjectIDOr404(rawID)
	if err != nil {
		writeAPIError(w, r, err)
		return
	}
	if _, err := s.cache.GetProject(id); err != nil {
		if isProjectNotFound(err) {
			writeAPIError(w, r, errProjectNotFound(rawID))
			return
		}
		s.logger.Error("symbols: cache lookup failed",
			slog.String("project_id", string(id)),
			slog.String("error", err.Error()))
		writeAPIError(w, r, errInternal())
		return
	}

	g, err := s.cache.ReadGraph(id)
	if err != nil {
		writeAPIError(w, r, translateGraphReadError(err, string(id)))
		return
	}

	receivers := containsReceiverIndex(g)
	out := make([]symbolEntry, 0, len(g.Nodes))
	for i := range g.Nodes {
		n := &g.Nodes[i]
		switch n.Kind {
		case domain.NodeKindFunc, domain.NodeKindStruct, domain.NodeKindInterface:
			if n.Package == "" || n.Name == "" {
				continue
			}
			out = append(out, symbolEntry{
				ID:      n.ID,
				Name:    n.Name,
				FQN:     n.Package + "#" + n.Name,
				Kind:    n.Kind,
				Package: n.Package,
			})
		case domain.NodeKindMethod:
			if n.Package == "" || n.Name == "" {
				continue
			}
			recv, ok := receivers[n.ID]
			if !ok || recv == "" {
				// Method without a resolvable receiver — the loader cannot
				// accept "pkg#method" for a method, so emitting an
				// incomplete entry would set the user up for the exact
				// invalid_entry_point failure this endpoint exists to
				// prevent. Skip it.
				continue
			}
			out = append(out, symbolEntry{
				ID:      n.ID,
				Name:    recv + "." + n.Name,
				FQN:     n.Package + "#" + recv + "." + n.Name,
				Kind:    n.Kind,
				Package: n.Package,
			})
		}
	}

	generatedAt, err := s.cache.GraphMTime(id)
	if err != nil {
		s.logger.Warn("symbols: GraphMTime failed",
			slog.String("project_id", string(id)),
			slog.String("error", err.Error()))
		generatedAt = time.Now().UTC()
	}

	writeJSON(w, http.StatusOK, symbolsResponse{
		ProjectID:   id,
		GeneratedAt: generatedAt,
		Count:       len(out),
		Symbols:     out,
	})
}

// containsReceiverIndex maps every method node id to the receiver (struct or
// interface) name that owns it, by walking the `contains` edges already
// emitted by GraphBuilder. The first qualifying parent wins so the result is
// deterministic.
func containsReceiverIndex(g *domain.Graph) map[string]string {
	byID := make(map[string]*domain.Node, len(g.Nodes))
	for i := range g.Nodes {
		byID[g.Nodes[i].ID] = &g.Nodes[i]
	}
	out := make(map[string]string)
	for _, e := range g.Edges {
		if e.Kind != domain.EdgeKindContains {
			continue
		}
		child, ok := byID[e.Target]
		if !ok || child.Kind != domain.NodeKindMethod {
			continue
		}
		if _, dup := out[e.Target]; dup {
			continue
		}
		parent, ok := byID[e.Source]
		if !ok {
			continue
		}
		if parent.Kind == domain.NodeKindStruct || parent.Kind == domain.NodeKindInterface {
			if parent.Name != "" {
				out[e.Target] = parent.Name
			}
		}
	}
	return out
}
