package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/vanek-goriachev/incogodevi/server/internal/cache"
	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// symbolsFixture builds a graph that mirrors the real-world bug repro:
// the same method name (`Run`) on two different receivers in two packages
// plus a free function and a dead method. The receiver must be recovered
// from the `contains` edge.
func symbolsFixture() *domain.Graph {
	const pkgA = "github.com/acme/internal/server"
	const pkgB = "github.com/acme/internal/worker"

	srvStruct := domain.Node{
		ID:      domain.NodeID(pkgA, "Server", ""),
		Name:    "Server",
		Kind:    domain.NodeKindStruct,
		Package: pkgA,
	}
	srvRun := domain.Node{
		ID:      domain.NodeID(pkgA, "Server", "Run"),
		Name:    "Run",
		Kind:    domain.NodeKindMethod,
		Package: pkgA,
	}
	wrkStruct := domain.Node{
		ID:      domain.NodeID(pkgB, "Worker", ""),
		Name:    "Worker",
		Kind:    domain.NodeKindStruct,
		Package: pkgB,
	}
	wrkRun := domain.Node{
		ID:      domain.NodeID(pkgB, "Worker", "Run"),
		Name:    "Run",
		Kind:    domain.NodeKindMethod,
		Package: pkgB,
	}
	freeFn := domain.Node{
		ID:      domain.NodeID(pkgB, "", "runOnce"),
		Name:    "runOnce",
		Kind:    domain.NodeKindFunc,
		Package: pkgB,
	}
	// Method on a struct that ALSO happens to be unreachable — should still
	// be emitted so the user can pin currently-dead handlers as entries.
	deadRun := domain.Node{
		ID:        domain.NodeID(pkgA, "Server", "Shutdown"),
		Name:      "Shutdown",
		Kind:      domain.NodeKindMethod,
		Package:   pkgA,
		Reachable: false,
	}
	// Field — must NOT appear in the symbol list.
	field := domain.Node{
		ID:      domain.NodeID(pkgA, "Server", "addr"),
		Name:    "addr",
		Kind:    domain.NodeKindField,
		Package: pkgA,
	}

	edges := []domain.Edge{
		{
			ID:     domain.EdgeID(srvStruct.ID, srvRun.ID, domain.EdgeKindContains),
			Source: srvStruct.ID, Target: srvRun.ID,
			Kind: domain.EdgeKindContains,
		},
		{
			ID:     domain.EdgeID(wrkStruct.ID, wrkRun.ID, domain.EdgeKindContains),
			Source: wrkStruct.ID, Target: wrkRun.ID,
			Kind: domain.EdgeKindContains,
		},
		{
			ID:     domain.EdgeID(srvStruct.ID, deadRun.ID, domain.EdgeKindContains),
			Source: srvStruct.ID, Target: deadRun.ID,
			Kind: domain.EdgeKindContains,
		},
		{
			ID:     domain.EdgeID(srvStruct.ID, field.ID, domain.EdgeKindContains),
			Source: srvStruct.ID, Target: field.ID,
			Kind: domain.EdgeKindContains,
		},
	}

	nodes := []domain.Node{srvStruct, srvRun, wrkStruct, wrkRun, freeFn, deadRun, field}
	return &domain.Graph{
		Nodes:         nodes,
		Edges:         edges,
		Stats:         buildStats(nodes, edges),
		SchemaVersion: domain.CurrentSchemaVersion,
	}
}

func seedSymbolsGraph(t *testing.T) (*httptest.Server, domain.ProjectID, cache.Manager) {
	t.Helper()
	srv, mgr := newTestServer(t)
	project, err := mgr.NewProject("symbols project", 1, 1)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	if err := mgr.WriteGraph(project.Meta.ID, symbolsFixture()); err != nil {
		t.Fatalf("WriteGraph: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts, project.Meta.ID, mgr
}

func TestSymbols_Happy(t *testing.T) {
	t.Parallel()
	ts, id, _ := seedSymbolsGraph(t)
	resp, err := http.Get(ts.URL + "/api/projects/" + string(id) + "/symbols")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: %d", resp.StatusCode)
	}
	var got symbolsResponse
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Count != len(got.Symbols) {
		t.Errorf("count %d != len(symbols) %d", got.Count, len(got.Symbols))
	}
	// Expect: 2 structs + 3 methods (Server.Run, Worker.Run, Server.Shutdown)
	// + 1 free func = 6. Field MUST NOT appear.
	if got.Count != 6 {
		t.Errorf("count: got %d, want 6 (symbols=%+v)", got.Count, got.Symbols)
	}

	byFQN := make(map[string]symbolEntry, len(got.Symbols))
	for _, s := range got.Symbols {
		byFQN[s.FQN] = s
	}

	const pkgA = "github.com/acme/internal/server"
	const pkgB = "github.com/acme/internal/worker"

	srvRun, ok := byFQN[pkgA+"#Server.Run"]
	if !ok {
		t.Fatalf("missing Server.Run entry: %+v", byFQN)
	}
	if srvRun.Kind != domain.NodeKindMethod {
		t.Errorf("Server.Run kind: got %q, want method", srvRun.Kind)
	}
	if srvRun.Name != "Server.Run" {
		t.Errorf("Server.Run name (label) got %q, want Server.Run", srvRun.Name)
	}

	if _, ok := byFQN[pkgB+"#Worker.Run"]; !ok {
		t.Errorf("missing Worker.Run entry")
	}
	if _, ok := byFQN[pkgB+"#runOnce"]; !ok {
		t.Errorf("missing runOnce free-func entry")
	}
	if _, ok := byFQN[pkgA+"#Server.Shutdown"]; !ok {
		t.Errorf("dead method Server.Shutdown must still be listed (it's a valid pin target)")
	}
	if _, ok := byFQN[pkgA+"#addr"]; ok {
		t.Errorf("field addr leaked into the symbol list")
	}
}

func TestSymbols_NotFound(t *testing.T) {
	t.Parallel()
	srv, _ := newTestServer(t)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/api/projects/nope/symbols")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status: got %d, want 404", resp.StatusCode)
	}
}
