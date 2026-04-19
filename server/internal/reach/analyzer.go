package reach

import (
	"fmt"
	"log/slog"
	"sort"

	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// Analyzer marks reachable nodes in a graph and emits a dead-code report.
//
// Instances are stateless beyond the logger and safe for concurrent use across
// distinct (graph, entryIDs) pairs.
type Analyzer struct {
	logger *slog.Logger
}

// New constructs an Analyzer. A nil logger falls back to slog.Default().
func New(logger *slog.Logger) *Analyzer {
	if logger == nil {
		logger = slog.Default()
	}
	return &Analyzer{logger: logger}
}

// Mark performs a BFS from entryIDs through the traversable edges (see
// docs/architecture.md §3.2) and updates Node.Reachable on g in place.
//
// It also recomputes g.Stats.DeadCount as len(Nodes) - |reached|. Entry IDs
// that do not match any node in g are silently skipped — the entry package is
// the source of truth for validation. The graph is mutated by index because
// ranging over g.Nodes by value yields copies whose Reachable flag would not
// survive the loop.
func (a *Analyzer) Mark(g *domain.Graph, entryIDs []string) error {
	if g == nil {
		return fmt.Errorf("reach: nil graph")
	}

	nodeIndex := indexNodes(g.Nodes)
	adjacency := buildAdjacency(g.Edges)
	reached := make(map[string]struct{}, len(g.Nodes))
	queue := make([]string, 0, len(entryIDs))

	for _, id := range entryIDs {
		if _, ok := nodeIndex[id]; !ok {
			continue
		}
		if _, seen := reached[id]; seen {
			continue
		}
		reached[id] = struct{}{}
		queue = append(queue, id)
	}

	for head := 0; head < len(queue); head++ {
		current := queue[head]
		for _, neighbour := range adjacency[current] {
			if _, seen := reached[neighbour]; seen {
				continue
			}
			if _, ok := nodeIndex[neighbour]; !ok {
				continue
			}
			reached[neighbour] = struct{}{}
			queue = append(queue, neighbour)
		}
	}

	for i := range g.Nodes {
		_, ok := reached[g.Nodes[i].ID]
		g.Nodes[i].Reachable = ok
	}
	g.Stats.DeadCount = len(g.Nodes) - len(reached)

	a.logger.Debug("reach: mark",
		slog.Int("nodes", len(g.Nodes)),
		slog.Int("edges", len(g.Edges)),
		slog.Int("entries", len(entryIDs)),
		slog.Int("reached", len(reached)),
		slog.Int("dead", g.Stats.DeadCount))

	return nil
}

// DeadCode collects every unreachable non-package node into a DeadCodeReport.
//
// Package nodes are intentionally omitted: a package is "dead" only when all
// of its children are dead, and reporting it alongside its members would
// double-count entries. Entries are sorted by FQN so the JSON output is
// deterministic across runs.
//
// generated_at and project_id are zero values; the HTTP layer (T16) overlays
// the live values when serialising the response.
func (a *Analyzer) DeadCode(g *domain.Graph) *domain.DeadCodeReport {
	if g == nil {
		return &domain.DeadCodeReport{Entries: []domain.DeadCodeEntry{}}
	}

	parents := containsParentIndex(g)
	nodeIndex := indexNodes(g.Nodes)

	entries := make([]domain.DeadCodeEntry, 0)
	for i := range g.Nodes {
		n := &g.Nodes[i]
		if n.Reachable || n.Kind == domain.NodeKindPackage {
			continue
		}
		entries = append(entries, domain.DeadCodeEntry{
			Kind:    n.Kind,
			FQN:     formatFQN(n, parents, nodeIndex, g.Nodes),
			Package: n.Package,
			Name:    n.Name,
			File:    n.File,
			Line:    n.Line,
			Reason:  "unreachable",
		})
	}

	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].FQN != entries[j].FQN {
			return entries[i].FQN < entries[j].FQN
		}
		if entries[i].File != entries[j].File {
			return entries[i].File < entries[j].File
		}
		return entries[i].Line < entries[j].Line
	})

	return &domain.DeadCodeReport{
		EntriesCount: len(entries),
		Entries:      entries,
	}
}

// indexNodes maps Node.ID to its position in nodes for O(1) existence checks.
func indexNodes(nodes []domain.Node) map[string]int {
	out := make(map[string]int, len(nodes))
	for i := range nodes {
		out[nodes[i].ID] = i
	}
	return out
}

// buildAdjacency turns the edge slice into an adjacency map honouring the
// per-EdgeKind direction policy:
//
//   - calls, references, embeds: source → target only.
//   - implements: bidirectional. Reaching an interface pulls in every
//     implementation; reaching an implementation pulls in the interface.
//   - contains: bidirectional. A reachable child keeps its container alive
//     (so methods do not detach from their struct/package), and a reachable
//     container exposes its members as live (entry on a struct should reach
//     its methods/fields).
//   - imports: not traversed. Importing a package does not imply that every
//     symbol inside it is used; only direct calls/references prove use.
//
// Every key/value is a Node.ID; resolution back to *Node is the caller's
// responsibility.
func buildAdjacency(edges []domain.Edge) map[string][]string {
	adj := make(map[string][]string)
	for _, e := range edges {
		switch e.Kind {
		case domain.EdgeKindCalls, domain.EdgeKindReferences, domain.EdgeKindEmbeds:
			adj[e.Source] = append(adj[e.Source], e.Target)
		case domain.EdgeKindContains, domain.EdgeKindImplements:
			adj[e.Source] = append(adj[e.Source], e.Target)
			adj[e.Target] = append(adj[e.Target], e.Source)
		case domain.EdgeKindImports:
			// imports are intentionally not traversable — see godoc above.
		}
	}
	return adj
}

// containsParentIndex maps a child Node.ID to its contains-parent's Node.ID.
//
// The graph builder emits exactly one contains-edge per child, but the map
// keeps the first parent it sees so the result is deterministic when (e.g. in
// a synthetic test graph) two parents claim the same child.
func containsParentIndex(g *domain.Graph) map[string]string {
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

// formatFQN renders a node into the canonical fully-qualified name shown in
// the dead-code report (docs/api-contract.md §4):
//
//   - methods and fields: "<pkg>.<Type>.<Member>"
//   - everything else: "<pkg>.<Name>"
//
// The owning type for methods/fields is recovered through parents because the
// node payload itself does not carry the receiver — only its hashed ID does.
// When the parent cannot be located (e.g. a synthetic graph that skipped the
// contains-edge) the function falls back to "<pkg>.<Name>" rather than failing
// loudly; the dead-code report stays useful even with imperfect input.
func formatFQN(
	n *domain.Node,
	parents map[string]string,
	nodeIndex map[string]int,
	nodes []domain.Node,
) string {
	switch n.Kind {
	case domain.NodeKindMethod, domain.NodeKindField:
		if parentID, ok := parents[n.ID]; ok {
			if idx, ok := nodeIndex[parentID]; ok {
				parent := nodes[idx]
				if parent.Kind == domain.NodeKindStruct || parent.Kind == domain.NodeKindInterface {
					return parent.Package + "." + parent.Name + "." + n.Name
				}
			}
		}
	}
	if n.Package == "" {
		return n.Name
	}
	if n.Name == "" {
		return n.Package
	}
	return n.Package + "." + n.Name
}
