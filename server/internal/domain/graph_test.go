package domain

import (
	"bytes"
	"encoding/gob"
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
)

func sampleGraph(nodeCount int) Graph {
	nodes := make([]Node, 0, nodeCount)
	edges := make([]Edge, 0, nodeCount)
	byKind := make(map[NodeKind]int, len(AllNodeKinds))
	for i := 0; i < nodeCount; i++ {
		kind := AllNodeKinds[i%len(AllNodeKinds)]
		name := fmt.Sprintf("Sym%d", i)
		pkg := fmt.Sprintf("example.com/pkg%d", i%4)
		id := NodeID(pkg, name, "")
		nodes = append(nodes, Node{
			ID:        id,
			Name:      name,
			Kind:      kind,
			Package:   pkg,
			File:      fmt.Sprintf("%s/file_%d.go", pkg, i),
			Line:      i + 1,
			Exported:  i%2 == 0,
			Reachable: i%3 != 0,
			IsEntry:   i == 0,
		})
		byKind[kind]++
		if i == 0 {
			continue
		}
		src := nodes[i-1].ID
		edges = append(edges, Edge{
			ID:     EdgeID(src, id, EdgeKindCalls),
			Source: src,
			Target: id,
			Kind:   EdgeKindCalls,
			Weight: 1,
		})
	}
	return Graph{
		Nodes:    nodes,
		Edges:    edges,
		Warnings: []Warning{{Code: "import_error", Message: "boom", Package: "example.com/pkg0"}},
		Stats: GraphStats{
			NodeCount: len(nodes),
			EdgeCount: len(edges),
			DeadCount: 0,
			ByKind:    byKind,
		},
		SchemaVersion: CurrentSchemaVersion,
	}
}

func TestGraph_JSONRoundTrip_Large(t *testing.T) {
	t.Parallel()

	g := sampleGraph(100)
	data, err := json.Marshal(g)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	var got Graph
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if !reflect.DeepEqual(got, g) {
		t.Fatalf("graph round trip mismatch")
	}
}

func TestGraph_GobRoundTrip(t *testing.T) {
	t.Parallel()

	g := sampleGraph(20)

	var buf bytes.Buffer
	if err := gob.NewEncoder(&buf).Encode(g); err != nil {
		t.Fatalf("gob encode: %v", err)
	}

	var got Graph
	if err := gob.NewDecoder(&buf).Decode(&got); err != nil {
		t.Fatalf("gob decode: %v", err)
	}
	if !reflect.DeepEqual(got, g) {
		t.Fatalf("graph gob round trip mismatch")
	}
}

func TestGraph_StatsSerialised(t *testing.T) {
	t.Parallel()

	g := Graph{
		Stats: GraphStats{
			NodeCount: 1,
			EdgeCount: 0,
			DeadCount: 0,
			ByKind:    map[NodeKind]int{NodeKindFunc: 1},
		},
		SchemaVersion: CurrentSchemaVersion,
	}
	data, err := json.Marshal(g)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	if !bytes.Contains(data, []byte(`"by_kind":{"func":1}`)) {
		t.Fatalf("expected by_kind in body: %s", data)
	}
	if !bytes.Contains(data, []byte(`"schema_version":1`)) {
		t.Fatalf("expected schema_version in body: %s", data)
	}
}
