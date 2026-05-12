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

	// levelStruct restricts a scope=<pkg> response to top-level struct /
	// interface nodes plus package-level vars/consts/funcs that are NOT
	// inside any struct. Used by the FE for the first dbltap on a package
	// node so the user is not flooded with methods and fields.
	levelStruct = "struct"
	// levelMembers returns the children (methods, fields, embedded types)
	// of the parent node identified by the `parent` query param. Combined
	// with scope=<pkg> it powers the second dbltap on a struct node.
	levelMembers = "members"
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

	q := r.URL.Query()
	view, aggregation, err := selectGraphView(g, q.Get("scope"), q.Get("aggregate"))
	if err != nil {
		writeAPIError(w, r, err)
		return
	}
	if scope := q.Get("scope"); scope != "" {
		level := q.Get("level")
		switch level {
		case "":
			// default behaviour — return everything in the package.
		case levelStruct:
			view = filterScopeStructLevel(g, view, scope)
		case levelMembers:
			parent := q.Get("parent")
			if parent != "" {
				view = filterScopeMembers(g, view, parent)
			}
		}
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

// scopeGraph returns a sub-graph view rooted at `scope`. The returned graph
// contains:
//
//   - every node whose Package equals scope (the "in-scope" nodes);
//   - every intra-scope edge (both endpoints in scope);
//   - boundary edges where exactly one endpoint is in scope, with the
//     foreign endpoint rewritten to point at the foreign package's
//     aggregated package-node id; and
//   - the foreign package nodes referenced by those boundary edges, so the
//     response is self-contained and the client does not have to depend on
//     cross-snapshot id stability.
//
// Boundary edges are essential for the "expand a package" gesture in the
// aggregated view: without them, after expansion the new sub-graph appears
// disconnected from every other (still-aggregated) package on the canvas.
//
// The contract requires a 400 invalid_scope envelope (with the list of valid
// packages in details) when scope does not match any node.
func scopeGraph(g *domain.Graph, scope string) (*domain.Graph, error) {
	pkgs := uniquePackages(g)
	if !contains(pkgs, scope) {
		return nil, errInvalidScope(scope, pkgs)
	}

	// Index every node by id and remember which package each id belongs to,
	// then locate the aggregated package-node id for each package so we can
	// rewrite boundary edges below. The package-node id is stable across the
	// aggregated and detail views because both derive it from `domain.NodeID`.
	nodeByID := make(map[string]*domain.Node, len(g.Nodes))
	pkgNodeID := make(map[string]string)
	for i := range g.Nodes {
		n := &g.Nodes[i]
		nodeByID[n.ID] = n
		if n.Kind == domain.NodeKindPackage {
			pkgNodeID[n.Package] = n.ID
		}
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
	// foreignPkgs collects ids of foreign package nodes we need to add to
	// `nodes` so the response is self-contained. We use a set to dedupe
	// across many boundary edges that point at the same foreign package.
	foreignPkgs := make(map[string]struct{})
	for _, e := range g.Edges {
		_, srcIn := keep[e.Source]
		_, dstIn := keep[e.Target]
		switch {
		case srcIn && dstIn:
			edges = append(edges, e)
		case srcIn:
			tn := nodeByID[e.Target]
			if tn == nil {
				continue
			}
			pid, ok := pkgNodeID[tn.Package]
			if !ok || pid == "" || pid == e.Target {
				continue
			}
			edges = append(edges, domain.Edge{
				ID:     e.ID + "@boundary",
				Source: e.Source,
				Target: pid,
				Kind:   e.Kind,
				Weight: e.Weight,
			})
			foreignPkgs[pid] = struct{}{}
		case dstIn:
			sn := nodeByID[e.Source]
			if sn == nil {
				continue
			}
			pid, ok := pkgNodeID[sn.Package]
			if !ok || pid == "" || pid == e.Source {
				continue
			}
			edges = append(edges, domain.Edge{
				ID:     e.ID + "@boundary",
				Source: pid,
				Target: e.Target,
				Kind:   e.Kind,
				Weight: e.Weight,
			})
			foreignPkgs[pid] = struct{}{}
		}
	}

	for pid := range foreignPkgs {
		if pn, ok := nodeByID[pid]; ok {
			nodes = append(nodes, *pn)
		}
	}

	return &domain.Graph{
		Nodes:         nodes,
		Edges:         edges,
		Warnings:      append([]domain.Warning(nil), g.Warnings...),
		Stats:         buildStats(nodes, edges),
		SchemaVersion: g.SchemaVersion,
	}, nil
}

// filterScopeStructLevel narrows view down to top-level structs / interfaces
// for the package plus package-level vars/consts/funcs (kind ∈ {var, const,
// func} that are NOT contained by a struct/interface). Foreign package nodes
// already in view (boundary endpoints) are kept so cross-package edges still
// have a target. Edges are pruned to those whose endpoints survived.
//
// fullGraph is the un-scoped graph; we need its contains edges to decide
// whether a var/func/const is package-level.
func filterScopeStructLevel(fullGraph, view *domain.Graph, scope string) *domain.Graph {
	parents := containsParentIndexLocal(fullGraph)

	// Map every node by id so we can look up parent kinds when filtering.
	byID := make(map[string]*domain.Node, len(fullGraph.Nodes))
	for i := range fullGraph.Nodes {
		byID[fullGraph.Nodes[i].ID] = &fullGraph.Nodes[i]
	}

	keep := make(map[string]struct{}, len(view.Nodes))
	nodes := make([]domain.Node, 0, len(view.Nodes))
	for _, n := range view.Nodes {
		if n.Package != scope {
			// Foreign / boundary node — keep so boundary edges remain valid.
			nodes = append(nodes, n)
			keep[n.ID] = struct{}{}
			continue
		}
		switch n.Kind {
		case domain.NodeKindStruct, domain.NodeKindInterface, domain.NodeKindPackage:
			nodes = append(nodes, n)
			keep[n.ID] = struct{}{}
		case domain.NodeKindVar, domain.NodeKindConst, domain.NodeKindFunc:
			parentID, ok := parents[n.ID]
			if !ok {
				nodes = append(nodes, n)
				keep[n.ID] = struct{}{}
				continue
			}
			parent, ok := byID[parentID]
			if !ok {
				nodes = append(nodes, n)
				keep[n.ID] = struct{}{}
				continue
			}
			if parent.Kind == domain.NodeKindStruct || parent.Kind == domain.NodeKindInterface {
				continue
			}
			nodes = append(nodes, n)
			keep[n.ID] = struct{}{}
		}
	}

	edges := make([]domain.Edge, 0, len(view.Edges))
	for _, e := range view.Edges {
		if _, okS := keep[e.Source]; !okS {
			continue
		}
		if _, okT := keep[e.Target]; !okT {
			continue
		}
		edges = append(edges, e)
	}

	return &domain.Graph{
		Nodes:         nodes,
		Edges:         edges,
		Warnings:      append([]domain.Warning(nil), view.Warnings...),
		Stats:         buildStats(nodes, edges),
		SchemaVersion: view.SchemaVersion,
	}
}

// filterScopeMembers narrows view to the direct children (methods, fields,
// embedded types) of parentID, plus parentID itself so the caller can anchor
// layout around it. Foreign boundary package nodes referenced by edges of
// surviving members are kept; edges are pruned the same way.
func filterScopeMembers(fullGraph, view *domain.Graph, parentID string) *domain.Graph {
	// Collect direct children of parentID via contains-edges.
	children := make(map[string]struct{})
	for _, e := range fullGraph.Edges {
		if e.Kind != domain.EdgeKindContains {
			continue
		}
		if e.Source == parentID {
			children[e.Target] = struct{}{}
		}
	}

	keep := make(map[string]struct{}, len(children)+1)
	keep[parentID] = struct{}{}
	for id := range children {
		keep[id] = struct{}{}
	}

	nodes := make([]domain.Node, 0, len(keep))
	for _, n := range view.Nodes {
		if _, ok := keep[n.ID]; ok {
			nodes = append(nodes, n)
			continue
		}
		// Foreign / boundary package nodes: keep them so boundary edges still
		// have a target. They have package != the scope but kind=package.
		if n.Kind == domain.NodeKindPackage {
			nodes = append(nodes, n)
			keep[n.ID] = struct{}{}
		}
	}

	// Annotate member nodes with `parent` so the FE can group them visually
	// (Cytoscape compound nodes); reuse the existing Node fields by writing
	// to a small helper map. We rebuild edges next.

	edges := make([]domain.Edge, 0, len(view.Edges))
	for _, e := range view.Edges {
		if _, okS := keep[e.Source]; !okS {
			continue
		}
		if _, okT := keep[e.Target]; !okT {
			continue
		}
		edges = append(edges, e)
	}

	return &domain.Graph{
		Nodes:         nodes,
		Edges:         edges,
		Warnings:      append([]domain.Warning(nil), view.Warnings...),
		Stats:         buildStats(nodes, edges),
		SchemaVersion: view.SchemaVersion,
	}
}

// containsParentIndexLocal mirrors reach.containsParentIndex without pulling
// the import. The graph builder emits exactly one contains-edge per child;
// the first parent wins on duplicates so the result is deterministic.
func containsParentIndexLocal(g *domain.Graph) map[string]string {
	out := make(map[string]string, len(g.Edges))
	for _, e := range g.Edges {
		if e.Kind != domain.EdgeKindContains {
			continue
		}
		if _, exists := out[e.Target]; exists {
			continue
		}
		out[e.Target] = e.Source
	}
	return out
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
