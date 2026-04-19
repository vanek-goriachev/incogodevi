package api

import (
	"errors"
	"log/slog"
	"net/http"
	"sort"
	"time"

	"github.com/vanek-goriachev/incogodevi/server/internal/cache"
	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
	"github.com/vanek-goriachev/incogodevi/server/internal/reach"
)

// aggregateAuto is the FR-18 threshold above which an "auto" request collapses
// the graph to package level. Mirrors docs/api-contract.md §3.
const aggregateAuto = 1000

// Recognised query parameter values for /api/projects/{id}/graph.
const (
	aggregateModeAuto    = "auto"
	aggregateModePackage = "package"
	aggregateModeNone    = "none"

	includeDeadTrue  = "true"
	includeDeadFalse = "false"

	aggregationNone    = "none"
	aggregationPackage = "package"
)

// graphResponse is the JSON envelope returned by /api/projects/{id}/graph
// (api-contract.md §3). The shape mirrors the contract verbatim.
type graphResponse struct {
	ProjectID   domain.ProjectID  `json:"project_id"`
	GeneratedAt time.Time         `json:"generated_at"`
	Aggregation string            `json:"aggregation"`
	Stats       domain.GraphStats `json:"stats"`
	Nodes       []domain.Node     `json:"nodes"`
	Edges       []domain.Edge     `json:"edges"`
	Warnings    []domain.Warning  `json:"warnings"`
}

// handleGraph implements GET /api/projects/{id}/graph. The flow is:
//
//  1. Validate the project_id path parameter.
//  2. Load the cached graph (404 / 503 on missing or corrupt artefacts).
//  3. Apply scope > aggregate > raw view selection (scope wins by contract).
//  4. Optionally drop unreachable nodes when include_dead=false.
//  5. Render the documented JSON envelope with deterministic stats.
func (s *Server) handleGraph(w http.ResponseWriter, r *http.Request) {
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
		s.logger.Error("graph: cache lookup failed",
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

	view, aggregation, err := selectGraphView(g, r.URL.Query().Get("scope"), r.URL.Query().Get("aggregate"))
	if err != nil {
		writeAPIError(w, r, err)
		return
	}

	includeDead := parseIncludeDead(r.URL.Query().Get("include_dead"))
	if !includeDead {
		view = filterDead(view)
	}

	generatedAt, err := s.cache.GraphMTime(id)
	if err != nil {
		// The graph just loaded successfully so the stat would only fail on
		// a race with eviction. Falling back to "now" keeps the response
		// honest without bubbling a 500 to the client for a transient race.
		s.logger.Warn("graph: GraphMTime failed",
			slog.String("project_id", string(id)),
			slog.String("error", err.Error()))
		generatedAt = time.Now().UTC()
	}

	writeJSON(w, http.StatusOK, graphResponse{
		ProjectID:   id,
		GeneratedAt: generatedAt,
		Aggregation: aggregation,
		Stats:       view.Stats,
		Nodes:       nonNilNodes(view.Nodes),
		Edges:       nonNilEdges(view.Edges),
		Warnings:    nonNilWarnings(view.Warnings),
	})
}

// selectGraphView resolves the scope / aggregate query parameters into the
// final view of g and reports the documented `aggregation` value. The scope
// parameter always wins when set: aggregate is silently ignored to keep the
// frontend's "expand a package" gesture unambiguous (T16 task notes).
func selectGraphView(g *domain.Graph, scope, aggregate string) (*domain.Graph, string, error) {
	if scope != "" {
		view, err := scopeGraph(g, scope)
		if err != nil {
			return nil, "", err
		}
		return view, aggregationNone, nil
	}
	switch aggregate {
	case "", aggregateModeAuto:
		if len(g.Nodes) > aggregateAuto {
			return reach.Aggregate(g), aggregationPackage, nil
		}
		return g, aggregationNone, nil
	case aggregateModePackage:
		return reach.Aggregate(g), aggregationPackage, nil
	case aggregateModeNone:
		return g, aggregationNone, nil
	default:
		// Unknown values fall back to "auto" semantics. The contract does not
		// document an error for this branch and the frontend treats anything
		// non-recognised as the default.
		if len(g.Nodes) > aggregateAuto {
			return reach.Aggregate(g), aggregationPackage, nil
		}
		return g, aggregationNone, nil
	}
}

// scopeGraph keeps only the nodes whose Package equals scope plus every edge
// whose endpoints both belong to scope. The contract requires a 400
// invalid_scope envelope (with the list of valid packages in details) when
// scope does not match any node.
func scopeGraph(g *domain.Graph, scope string) (*domain.Graph, error) {
	pkgs := uniquePackages(g)
	if !contains(pkgs, scope) {
		return nil, errInvalidScope(scope, pkgs)
	}

	keep := make(map[string]struct{}, len(g.Nodes))
	nodes := make([]domain.Node, 0)
	for _, n := range g.Nodes {
		if n.Package != scope {
			continue
		}
		nodes = append(nodes, n)
		keep[n.ID] = struct{}{}
	}

	edges := make([]domain.Edge, 0, len(g.Edges))
	for _, e := range g.Edges {
		if _, srcOK := keep[e.Source]; !srcOK {
			continue
		}
		if _, dstOK := keep[e.Target]; !dstOK {
			continue
		}
		edges = append(edges, e)
	}

	return &domain.Graph{
		Nodes:         nodes,
		Edges:         edges,
		Warnings:      append([]domain.Warning(nil), g.Warnings...),
		Stats:         buildStats(nodes, edges),
		SchemaVersion: g.SchemaVersion,
	}, nil
}

// uniquePackages returns the sorted set of Package paths present in g. The
// list backs the invalid_scope error message so callers can recover from
// typos.
func uniquePackages(g *domain.Graph) []string {
	seen := make(map[string]struct{}, len(g.Nodes))
	for _, n := range g.Nodes {
		if n.Package == "" {
			continue
		}
		seen[n.Package] = struct{}{}
	}
	out := make([]string, 0, len(seen))
	for pkg := range seen {
		out = append(out, pkg)
	}
	sort.Strings(out)
	return out
}

// filterDead returns a copy of g without any node whose Reachable is false and
// without any edge whose endpoint references a dropped node.
func filterDead(g *domain.Graph) *domain.Graph {
	keep := make(map[string]struct{}, len(g.Nodes))
	nodes := make([]domain.Node, 0, len(g.Nodes))
	for _, n := range g.Nodes {
		if !n.Reachable {
			continue
		}
		nodes = append(nodes, n)
		keep[n.ID] = struct{}{}
	}
	edges := make([]domain.Edge, 0, len(g.Edges))
	for _, e := range g.Edges {
		if _, srcOK := keep[e.Source]; !srcOK {
			continue
		}
		if _, dstOK := keep[e.Target]; !dstOK {
			continue
		}
		edges = append(edges, e)
	}
	return &domain.Graph{
		Nodes:         nodes,
		Edges:         edges,
		Warnings:      append([]domain.Warning(nil), g.Warnings...),
		Stats:         buildStats(nodes, edges),
		SchemaVersion: g.SchemaVersion,
	}
}

// buildStats computes a fresh GraphStats matching the supplied node/edge view.
// Recomputing here (rather than inheriting from the source graph) keeps the
// numbers consistent after scope or include_dead filtering.
func buildStats(nodes []domain.Node, edges []domain.Edge) domain.GraphStats {
	by := make(map[domain.NodeKind]int)
	dead := 0
	for _, n := range nodes {
		by[n.Kind]++
		if !n.Reachable {
			dead++
		}
	}
	return domain.GraphStats{
		NodeCount: len(nodes),
		EdgeCount: len(edges),
		DeadCount: dead,
		ByKind:    by,
	}
}

// parseIncludeDead implements the documented default-on behaviour. Any value
// other than the literal "false" leaves dead nodes in the response.
func parseIncludeDead(raw string) bool {
	switch raw {
	case "", includeDeadTrue:
		return true
	case includeDeadFalse:
		return false
	default:
		return true
	}
}

// translateGraphReadError converts cache-layer sentinels into the documented
// HTTP envelopes. Unknown errors fall back to a logged 500 so we never leak
// implementation details.
func translateGraphReadError(err error, projectID string) error {
	switch {
	case errors.Is(err, domain.ErrProjectNotFound):
		return errProjectNotFound(projectID)
	case errors.Is(err, domain.ErrNoGraphYet):
		return errNoGraphYet(projectID)
	case errors.Is(err, cache.ErrStaleCache), errors.Is(err, cache.ErrSchemaMismatch):
		return errStaleCache(projectID)
	}
	return err
}

// nonNilNodes / nonNilEdges / nonNilWarnings normalise nil slices to empty
// slices so the JSON envelope always carries the documented arrays rather
// than `null`. Cytoscape treats `null` as a fatal payload.
func nonNilNodes(in []domain.Node) []domain.Node {
	if in == nil {
		return []domain.Node{}
	}
	return in
}

func nonNilEdges(in []domain.Edge) []domain.Edge {
	if in == nil {
		return []domain.Edge{}
	}
	return in
}

func nonNilWarnings(in []domain.Warning) []domain.Warning {
	if in == nil {
		return []domain.Warning{}
	}
	return in
}

// contains reports whether haystack holds needle. It is a single-purpose
// helper kept here to avoid pulling slices.Contains in for one call site.
func contains(haystack []string, needle string) bool {
	for _, v := range haystack {
		if v == needle {
			return true
		}
	}
	return false
}
