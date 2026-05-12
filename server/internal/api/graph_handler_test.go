package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vanek-goriachev/incogodevi/server/internal/cache"
	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// graphFixture builds a small detail-level graph spanning two packages with
// one reachable and one dead member each.
func graphFixture() *domain.Graph {
	pkgA := "example.com/foo/bar"
	pkgB := "example.com/foo/baz"
	pkgAID := domain.NodeID(pkgA, "", "")
	pkgBID := domain.NodeID(pkgB, "", "")

	aliveA := domain.Node{
		ID:        domain.NodeID(pkgA, "", "Alive"),
		Name:      "Alive",
		Kind:      domain.NodeKindFunc,
		Package:   pkgA,
		File:      "bar/alive.go",
		Line:      10,
		Exported:  true,
		Reachable: true,
	}
	deadA := domain.Node{
		ID:        domain.NodeID(pkgA, "", "Dead"),
		Name:      "Dead",
		Kind:      domain.NodeKindFunc,
		Package:   pkgA,
		File:      "bar/dead.go",
		Line:      20,
		Exported:  false,
		Reachable: false,
	}
	aliveB := domain.Node{
		ID:        domain.NodeID(pkgB, "", "Alive"),
		Name:      "Alive",
		Kind:      domain.NodeKindFunc,
		Package:   pkgB,
		File:      "baz/alive.go",
		Line:      30,
		Exported:  true,
		Reachable: true,
	}
	deadB := domain.Node{
		ID:        domain.NodeID(pkgB, "", "Dead"),
		Name:      "Dead",
		Kind:      domain.NodeKindFunc,
		Package:   pkgB,
		File:      "baz/dead.go",
		Line:      40,
		Exported:  false,
		Reachable: false,
	}

	pkgNodeA := domain.Node{
		ID: pkgAID, Name: "bar", Kind: domain.NodeKindPackage,
		Package: pkgA, Reachable: true, Exported: true,
	}
	pkgNodeB := domain.Node{
		ID: pkgBID, Name: "baz", Kind: domain.NodeKindPackage,
		Package: pkgB, Reachable: true, Exported: true,
	}

	edges := []domain.Edge{
		{
			ID:     domain.EdgeID(aliveA.ID, aliveB.ID, domain.EdgeKindCalls),
			Source: aliveA.ID, Target: aliveB.ID,
			Kind: domain.EdgeKindCalls, Weight: 1,
		},
		{
			ID:     domain.EdgeID(aliveA.ID, deadA.ID, domain.EdgeKindCalls),
			Source: aliveA.ID, Target: deadA.ID,
			Kind: domain.EdgeKindCalls, Weight: 1,
		},
		{
			ID:     domain.EdgeID(pkgAID, pkgBID, domain.EdgeKindImports),
			Source: pkgAID, Target: pkgBID,
			Kind: domain.EdgeKindImports, Weight: 1,
		},
	}

	nodes := []domain.Node{pkgNodeA, pkgNodeB, aliveA, deadA, aliveB, deadB}
	return &domain.Graph{
		Nodes:         nodes,
		Edges:         edges,
		Stats:         buildStats(nodes, edges),
		SchemaVersion: domain.CurrentSchemaVersion,
	}
}

// seedGraph creates a fresh project, persists graphFixture as graph.json and
// returns the live test server backed by it.
func seedGraph(t *testing.T) (*httptest.Server, domain.ProjectID, cache.Manager) {
	t.Helper()
	srv, mgr := newTestServer(t)
	project, err := mgr.NewProject("foo project", 1, 1)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	if err := mgr.WriteGraph(project.Meta.ID, graphFixture()); err != nil {
		t.Fatalf("WriteGraph: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, project.Meta.ID, mgr
}

func decodeGraphResponse(t *testing.T, body io.Reader) graphResponse {
	t.Helper()
	var resp graphResponse
	if err := json.NewDecoder(body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return resp
}

func TestGraph_Happy(t *testing.T) {
	t.Parallel()

	ts, id, _ := seedGraph(t)
	resp, err := http.Get(ts.URL + "/api/projects/" + string(id) + "/graph")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: %d", resp.StatusCode)
	}
	got := decodeGraphResponse(t, resp.Body)
	if got.ProjectID != id {
		t.Errorf("project_id: got %q, want %q", got.ProjectID, id)
	}
	if got.Aggregation != aggregationNone {
		t.Errorf("aggregation: got %q, want %q", got.Aggregation, aggregationNone)
	}
	if got.Stats.NodeCount != 6 {
		t.Errorf("node_count: got %d, want 6", got.Stats.NodeCount)
	}
	if got.Stats.DeadCount != 2 {
		t.Errorf("dead_count: got %d, want 2", got.Stats.DeadCount)
	}
	if got.GeneratedAt.IsZero() {
		t.Errorf("generated_at must be populated")
	}
}

func TestGraph_AggregatePackage(t *testing.T) {
	t.Parallel()

	ts, id, _ := seedGraph(t)
	resp, err := http.Get(ts.URL + "/api/projects/" + string(id) + "/graph?aggregate=package")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	got := decodeGraphResponse(t, resp.Body)
	if got.Aggregation != aggregationPackage {
		t.Errorf("aggregation: got %q, want %q", got.Aggregation, aggregationPackage)
	}
	for _, n := range got.Nodes {
		if n.Kind != domain.NodeKindPackage {
			t.Errorf("aggregated graph contains non-package node %q", n.ID)
		}
	}
}

func TestGraph_AggregateAuto_BelowThresholdStaysDetailed(t *testing.T) {
	t.Parallel()

	ts, id, _ := seedGraph(t)
	resp, err := http.Get(ts.URL + "/api/projects/" + string(id) + "/graph?aggregate=auto")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	got := decodeGraphResponse(t, resp.Body)
	if got.Aggregation != aggregationNone {
		t.Errorf("aggregation: got %q, want %q", got.Aggregation, aggregationNone)
	}
}

func TestGraph_AggregateAuto_AboveThresholdAggregates(t *testing.T) {
	t.Parallel()

	srv, mgr := newTestServer(t)
	project, err := mgr.NewProject("big", 1, 1)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	g := makeBigGraph(aggregateAuto + 5)
	if err := mgr.WriteGraph(project.Meta.ID, g); err != nil {
		t.Fatalf("WriteGraph: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/api/projects/" + string(project.Meta.ID) + "/graph")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	got := decodeGraphResponse(t, resp.Body)
	if got.Aggregation != aggregationPackage {
		t.Fatalf("aggregation: got %q, want %q", got.Aggregation, aggregationPackage)
	}
	if got.Stats.NodeCount > aggregateAuto {
		t.Errorf("aggregated stats still report > threshold: %d", got.Stats.NodeCount)
	}
}

func TestGraph_AggregateNone(t *testing.T) {
	t.Parallel()

	ts, id, _ := seedGraph(t)
	resp, err := http.Get(ts.URL + "/api/projects/" + string(id) + "/graph?aggregate=none")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	got := decodeGraphResponse(t, resp.Body)
	if got.Aggregation != aggregationNone {
		t.Errorf("aggregation: got %q, want %q", got.Aggregation, aggregationNone)
	}
}

func TestGraph_ScopeHappyPath(t *testing.T) {
	t.Parallel()

	ts, id, _ := seedGraph(t)
	scope := "example.com/foo/bar"
	resp, err := http.Get(ts.URL + "/api/projects/" + string(id) + "/graph?scope=" + scope)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	got := decodeGraphResponse(t, resp.Body)
	if got.Aggregation != aggregationNone {
		t.Errorf("aggregation: got %q, want none", got.Aggregation)
	}
	// Every non-package node must belong to the scope. Package nodes from a
	// different package are allowed (they are foreign-package boundary
	// anchors so cross-package edges can still be rendered).
	inScope := 0
	foreignPkgNodes := 0
	for _, n := range got.Nodes {
		if n.Package == scope {
			inScope++
			continue
		}
		if n.Kind == domain.NodeKindPackage {
			foreignPkgNodes++
			continue
		}
		t.Errorf("node %q has package %q, expected %q", n.ID, n.Package, scope)
	}
	// scope contains: 1 package node + Alive + Dead = 3 in-scope nodes.
	if inScope != 3 {
		t.Errorf("in-scope node count: got %d, want 3", inScope)
	}
	// Foreign package node 'baz' is referenced by the Alive→Alive boundary
	// edge so it must appear in the response exactly once.
	if foreignPkgNodes != 1 {
		t.Errorf("foreign package nodes: got %d, want 1", foreignPkgNodes)
	}
}

func TestGraph_ScopeBeatsAggregate(t *testing.T) {
	t.Parallel()

	ts, id, _ := seedGraph(t)
	scope := "example.com/foo/bar"
	url := ts.URL + "/api/projects/" + string(id) + "/graph?scope=" + scope + "&aggregate=package"
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	got := decodeGraphResponse(t, resp.Body)
	if got.Aggregation != aggregationNone {
		t.Errorf("aggregation: got %q, want none (scope must win over aggregate)", got.Aggregation)
	}
	// Detail nodes must all belong to scope; foreign package nodes are
	// allowed (they appear as boundary anchors for cross-package edges).
	for _, n := range got.Nodes {
		if n.Package != scope && n.Kind != domain.NodeKindPackage {
			t.Errorf("non-package node out of scope: %q (pkg=%q)", n.ID, n.Package)
		}
	}
}

func TestGraph_ScopeBoundaryEdges(t *testing.T) {
	t.Parallel()

	ts, id, _ := seedGraph(t)
	scope := "example.com/foo/bar"
	resp, err := http.Get(ts.URL + "/api/projects/" + string(id) + "/graph?scope=" + scope)
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	got := decodeGraphResponse(t, resp.Body)

	// The Alive→Alive cross-package edge from the fixture must surface as
	// a boundary edge whose target is the foreign package's package-node id.
	foreignPkgID := domain.NodeID("example.com/foo/baz", "", "")
	aliveAID := domain.NodeID(scope, "", "Alive")
	var found bool
	for _, e := range got.Edges {
		if e.Source == aliveAID && e.Target == foreignPkgID {
			found = true
			if !strings.HasSuffix(e.ID, "@boundary") {
				t.Errorf("boundary edge id missing @boundary suffix: %q", e.ID)
			}
			break
		}
	}
	if !found {
		t.Errorf("expected boundary edge %s -> %s, edges: %+v", aliveAID, foreignPkgID, got.Edges)
	}

	// And the foreign package node must be embedded in the response so the
	// client never has to depend on cross-snapshot id stability.
	var hasForeignPkg bool
	for _, n := range got.Nodes {
		if n.ID == foreignPkgID && n.Kind == domain.NodeKindPackage {
			hasForeignPkg = true
			break
		}
	}
	if !hasForeignPkg {
		t.Errorf("foreign package node %q missing from scoped response", foreignPkgID)
	}
}

func TestGraph_InvalidScope(t *testing.T) {
	t.Parallel()

	ts, id, _ := seedGraph(t)
	resp, err := http.Get(ts.URL + "/api/projects/" + string(id) + "/graph?scope=does/not/exist")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status: got %d, want 400", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"code":"invalid_scope"`) {
		t.Errorf("envelope: %s", body)
	}
	// details.packages must list valid packages so the client can recover.
	if !strings.Contains(string(body), `"packages"`) {
		t.Errorf("missing packages list: %s", body)
	}
}

func TestGraph_IncludeDeadFalseDropsUnreachable(t *testing.T) {
	t.Parallel()

	ts, id, _ := seedGraph(t)
	resp, err := http.Get(ts.URL + "/api/projects/" + string(id) + "/graph?include_dead=false")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	got := decodeGraphResponse(t, resp.Body)
	for _, n := range got.Nodes {
		if !n.Reachable {
			t.Errorf("dead node leaked: %q", n.ID)
		}
	}
	for _, e := range got.Edges {
		// Both endpoints must be present in the filtered node set.
		if !nodeSetHas(got.Nodes, e.Source) || !nodeSetHas(got.Nodes, e.Target) {
			t.Errorf("edge %q references dropped node", e.ID)
		}
	}
	if got.Stats.DeadCount != 0 {
		t.Errorf("dead_count: got %d, want 0", got.Stats.DeadCount)
	}
}

func TestGraph_NoGraphYet404(t *testing.T) {
	t.Parallel()

	srv, mgr := newTestServer(t)
	project, _ := mgr.NewProject("never analysed", 1, 1)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/api/projects/" + string(project.Meta.ID) + "/graph")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status: got %d, want 404", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"code":"no_graph_yet"`) {
		t.Errorf("envelope: %s", body)
	}
}

func TestGraph_StaleCache503(t *testing.T) {
	t.Parallel()

	srv, mgr := newTestServer(t)
	project, _ := mgr.NewProject("corrupt", 1, 1)
	// Write garbage that os.Stat finds but json.Unmarshal rejects.
	if err := writeGraphRaw(t, mgr, project.Meta.ID, []byte("not-json")); err != nil {
		t.Fatalf("seed corrupt graph: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/api/projects/" + string(project.Meta.ID) + "/graph")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status: got %d, want 503", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"code":"stale_cache"`) {
		t.Errorf("envelope: %s", body)
	}
}

func TestGraph_ProjectNotFound(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServer(t)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	missing := domain.NewProjectID()
	resp, err := http.Get(ts.URL + "/api/projects/" + string(missing) + "/graph")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status: %d, want 404", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(body), `"code":"project_not_found"`) {
		t.Errorf("envelope: %s", body)
	}
}

func TestGraph_GarbageProjectIDIs404(t *testing.T) {
	t.Parallel()

	srv, _ := newTestServer(t)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/api/projects/garbage/graph")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status: %d, want 404", resp.StatusCode)
	}
}

func TestGraph_UnknownAggregateValueFallsBack(t *testing.T) {
	t.Parallel()

	ts, id, _ := seedGraph(t)
	resp, err := http.Get(ts.URL + "/api/projects/" + string(id) + "/graph?aggregate=bogus")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: %d", resp.StatusCode)
	}
	got := decodeGraphResponse(t, resp.Body)
	if got.Aggregation != aggregationNone {
		t.Errorf("aggregation: got %q, want %q (fallback)", got.Aggregation, aggregationNone)
	}
}

func TestGraph_IncludeDeadGarbageDefaultsToTrue(t *testing.T) {
	t.Parallel()

	ts, id, _ := seedGraph(t)
	resp, err := http.Get(ts.URL + "/api/projects/" + string(id) + "/graph?include_dead=maybe")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	got := decodeGraphResponse(t, resp.Body)
	if got.Stats.DeadCount == 0 {
		t.Errorf("dead nodes were dropped on garbage include_dead value")
	}
}

func TestTranslateGraphReadError_ProjectNotFound(t *testing.T) {
	t.Parallel()

	out := translateGraphReadError(domain.ErrProjectNotFound, "abc")
	apiErr, ok := asAPIError(out)
	if !ok || apiErr.Code != codeProjectNotFound {
		t.Fatalf("got %v, want project_not_found", out)
	}
}

func TestTranslateGraphReadError_UnknownPropagates(t *testing.T) {
	t.Parallel()

	bogus := io.EOF
	out := translateGraphReadError(bogus, "abc")
	if out != bogus {
		t.Errorf("unknown error should be returned untouched: got %v", out)
	}
}

func TestNonNilHelpersConvertNilToEmpty(t *testing.T) {
	t.Parallel()

	if got := nonNilNodes(nil); got == nil || len(got) != 0 {
		t.Errorf("nonNilNodes(nil) = %v", got)
	}
	if got := nonNilEdges(nil); got == nil || len(got) != 0 {
		t.Errorf("nonNilEdges(nil) = %v", got)
	}
	if got := nonNilWarnings(nil); got == nil || len(got) != 0 {
		t.Errorf("nonNilWarnings(nil) = %v", got)
	}
}

func nodeSetHas(nodes []domain.Node, id string) bool {
	for _, n := range nodes {
		if n.ID == id {
			return true
		}
	}
	return false
}

// makeBigGraph builds a graph with totalChildren detail-level nodes spread
// across two packages so the auto-aggregation threshold trips.
func makeBigGraph(totalChildren int) *domain.Graph {
	packages := []string{"example.com/big/a", "example.com/big/b"}
	nodes := make([]domain.Node, 0, totalChildren+len(packages))
	for _, pkg := range packages {
		nodes = append(nodes, domain.Node{
			ID:        domain.NodeID(pkg, "", ""),
			Name:      shortPkg(pkg),
			Kind:      domain.NodeKindPackage,
			Package:   pkg,
			Reachable: true,
			Exported:  true,
		})
	}
	for i := 0; i < totalChildren; i++ {
		pkg := packages[i%len(packages)]
		name := fmt.Sprintf("Fn%d", i)
		nodes = append(nodes, domain.Node{
			ID:        domain.NodeID(pkg, "", name),
			Name:      name,
			Kind:      domain.NodeKindFunc,
			Package:   pkg,
			Reachable: true,
			File:      pkg + "/file.go",
			Line:      i + 1,
		})
	}
	return &domain.Graph{
		Nodes:         nodes,
		Edges:         nil,
		Stats:         buildStats(nodes, nil),
		SchemaVersion: domain.CurrentSchemaVersion,
	}
}

func shortPkg(p string) string {
	for i := len(p) - 1; i >= 0; i-- {
		if p[i] == '/' {
			return p[i+1:]
		}
	}
	return p
}

// writeGraphRaw bypasses cache.WriteGraph so tests can install corrupt data.
func writeGraphRaw(t *testing.T, mgr cache.Manager, id domain.ProjectID, body []byte) error {
	t.Helper()
	project, err := mgr.GetProject(id)
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(project.CacheDir, "graph.json"), body, 0o600)
}
