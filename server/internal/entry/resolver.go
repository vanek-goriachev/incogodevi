package entry

import (
	"fmt"
	"go/types"
	"log/slog"
	"sort"
	"strings"

	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
	"github.com/vanek-goriachev/incogodevi/server/internal/parser"
)

// Resolver turns an EntryPointSpec into a deduplicated, sorted list of
// Node.IDs. Instances are stateless and safe for concurrent use across
// distinct calls.
type Resolver struct {
	logger *slog.Logger
}

// New constructs a Resolver. A nil logger falls back to slog.Default().
func New(logger *slog.Logger) *Resolver {
	if logger == nil {
		logger = slog.Default()
	}
	return &Resolver{logger: logger}
}

// Resolve returns the seed set for the reachability traversal alongside any
// non-fatal warnings collected along the way.
//
// Errors are returned as *domain.APIError values wrapping
// domain.ErrInvalidEntryPoint so the HTTP layer (T15) can surface a 400
// response with a "details.fqns" payload listing every malformed or
// unresolvable manual FQN. The graph is never mutated; the caller flips
// Node.IsEntry on the returned IDs.
func (r *Resolver) Resolve(
	spec domain.EntryPointSpec,
	pkgs []parser.LivePackage,
	g *domain.Graph,
) ([]string, []domain.Warning, error) {
	if !spec.Mode.IsValid() {
		return nil, nil, invalidSpec(fmt.Sprintf("unknown mode %q", spec.Mode))
	}
	if g == nil {
		return nil, nil, fmt.Errorf("entry: nil graph")
	}

	pkgIndex := indexPackages(pkgs)
	nodeIndex := indexNodes(g.Nodes)

	collected := make(map[string]struct{})
	var warnings []domain.Warning

	if spec.Mode == domain.EntryPointModeAuto || spec.Mode == domain.EntryPointModeMixed {
		ids := resolveAuto(pkgs, nodeIndex)
		for _, id := range ids {
			collected[id] = struct{}{}
		}
		if len(ids) == 0 {
			warnings = append(warnings, domain.Warning{
				Code:    "no_auto_entry_points",
				Message: "no func main() found in any project-local package main",
			})
		}
	}

	if spec.Mode == domain.EntryPointModeManual || spec.Mode == domain.EntryPointModeMixed {
		ids, invalid := resolveManual(spec.Manual, pkgIndex, nodeIndex)
		if len(invalid) > 0 {
			return nil, nil, invalidEntryPoints(invalid)
		}
		for _, id := range ids {
			collected[id] = struct{}{}
		}
	}

	if len(spec.InterfaceImpl) > 0 {
		ids, invalid := resolveInterfaceImpl(spec.InterfaceImpl, pkgIndex, nodeIndex, g)
		if len(invalid) > 0 {
			return nil, nil, invalidEntryPoints(invalid)
		}
		for _, id := range ids {
			collected[id] = struct{}{}
		}
	}

	out := make([]string, 0, len(collected))
	for id := range collected {
		out = append(out, id)
	}
	sort.Strings(out)

	r.logger.Debug("entry: resolved",
		slog.String("mode", string(spec.Mode)),
		slog.Int("manual", len(spec.Manual)),
		slog.Int("interface_impl", len(spec.InterfaceImpl)),
		slog.Int("entries", len(out)))

	return out, warnings, nil
}

// resolveAuto returns the Node.IDs of every func main() declared in a
// project-local "package main". The graph already carries those nodes; we
// walk the live type information to discover the receiver-less main
// functions and translate them through the node index.
func resolveAuto(pkgs []parser.LivePackage, nodeIndex map[string]int) []string {
	var ids []string
	for _, pkg := range pkgs {
		if pkg.Types == nil || pkg.Name != "main" {
			continue
		}
		scope := pkg.Types.Scope()
		obj := scope.Lookup("main")
		fn, ok := obj.(*types.Func)
		if !ok {
			continue
		}
		sig, ok := fn.Type().(*types.Signature)
		if !ok || sig.Recv() != nil {
			continue
		}
		id := domain.NodeID(pkg.PkgPath, "", "main")
		if _, present := nodeIndex[id]; !present {
			continue
		}
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// resolveManual walks every supplied FQN, looks the symbol up via
// types.Scope.Lookup and returns the resulting Node.IDs alongside the FQNs
// that could not be resolved. A malformed FQN (missing "#" or empty
// component) is reported in the invalid slice without aborting the loop so
// the caller can surface the full list to the user in one round-trip.
func resolveManual(
	manual []string,
	pkgIndex map[string]parser.LivePackage,
	nodeIndex map[string]int,
) (ids []string, invalid []string) {
	for _, raw := range manual {
		fqn := strings.TrimSpace(raw)
		pkgPath, typeName, member, ok := parseManualFQN(fqn)
		if !ok {
			invalid = append(invalid, raw)
			continue
		}
		pkg, ok := pkgIndex[pkgPath]
		if !ok || pkg.Types == nil {
			invalid = append(invalid, raw)
			continue
		}
		id, ok := lookupSymbol(pkg, typeName, member, nodeIndex)
		if !ok {
			invalid = append(invalid, raw)
			continue
		}
		ids = append(ids, id)
	}
	return ids, invalid
}

// resolveInterfaceImpl expands every interface FQN into the Node.IDs of all
// methods declared on its project-local implementations. Implementation
// discovery rides on the implements-edges produced by the graph builder so
// that resolver and graph cannot disagree about who implements what.
func resolveInterfaceImpl(
	interfaces []string,
	pkgIndex map[string]parser.LivePackage,
	nodeIndex map[string]int,
	g *domain.Graph,
) (ids []string, invalid []string) {
	implementsByTarget := indexImplementsEdges(g.Edges)
	containsBySource := indexContainsEdges(g.Edges)

	for _, raw := range interfaces {
		fqn := strings.TrimSpace(raw)
		pkgPath, typeName, member, ok := parseManualFQN(fqn)
		if !ok || member != "" {
			invalid = append(invalid, raw)
			continue
		}
		if _, ok := pkgIndex[pkgPath]; !ok {
			invalid = append(invalid, raw)
			continue
		}
		ifaceID := domain.NodeID(pkgPath, typeName, "")
		idx, present := nodeIndex[ifaceID]
		if !present || g.Nodes[idx].Kind != domain.NodeKindInterface {
			invalid = append(invalid, raw)
			continue
		}
		for _, implID := range implementsByTarget[ifaceID] {
			for _, methodID := range containsBySource[implID] {
				if g.Nodes[nodeIndex[methodID]].Kind == domain.NodeKindMethod {
					ids = append(ids, methodID)
				}
			}
		}
	}
	return ids, invalid
}

// parseManualFQN splits a manual entry-point string into its three optional
// parts. Accepted shapes:
//
//	"<pkg>#<Type>.<Method>"
//	"<pkg>#<Type>"
//	"<pkg>#<Func>"
//
// pkgPath, typeName and member are returned in that order. ok is false when
// the input is empty, lacks the "#" separator, or carries an empty component.
//
// The "#" separator was chosen because the canonical Go package path uses
// "/" and "." liberally; the out-of-band note in the task warns against
// switching to "." which would create an ambiguity around tools/example.com.
func parseManualFQN(fqn string) (pkgPath, typeName, member string, ok bool) {
	if fqn == "" {
		return "", "", "", false
	}
	hash := strings.Index(fqn, "#")
	if hash <= 0 || hash == len(fqn)-1 {
		return "", "", "", false
	}
	pkgPath = fqn[:hash]
	right := fqn[hash+1:]
	if dot := strings.Index(right, "."); dot >= 0 {
		if dot == 0 || dot == len(right)-1 {
			return "", "", "", false
		}
		typeName = right[:dot]
		member = right[dot+1:]
	} else {
		typeName = right
	}
	return pkgPath, typeName, member, true
}

// lookupSymbol resolves typeName/member against pkg's type scope and returns
// the matching Node.ID if and only if the GraphBuilder has emitted a node
// for it. A symbol that exists in scope but lacks a node (e.g. a stdlib
// re-export) is reported as not found so the user gets actionable feedback.
func lookupSymbol(
	pkg parser.LivePackage,
	typeName, member string,
	nodeIndex map[string]int,
) (string, bool) {
	scope := pkg.Types.Scope()

	// "pkg#Func" — typeName is actually the func name, member is empty.
	if member == "" {
		obj := scope.Lookup(typeName)
		switch o := obj.(type) {
		case *types.Func:
			id := domain.NodeID(pkg.PkgPath, "", typeName)
			if _, ok := nodeIndex[id]; ok {
				return id, true
			}
		case *types.Var, *types.Const, *types.TypeName:
			_ = o
			id := domain.NodeID(pkg.PkgPath, "", typeName)
			if _, ok := nodeIndex[id]; ok {
				return id, true
			}
			// Type-only entry: fall back to the type-shape NodeID.
			id = domain.NodeID(pkg.PkgPath, typeName, "")
			if _, ok := nodeIndex[id]; ok {
				return id, true
			}
		}
		return "", false
	}

	// "pkg#Type.Method" — find the named type, then its method by name.
	tn, ok := scope.Lookup(typeName).(*types.TypeName)
	if !ok {
		return "", false
	}
	named, ok := types.Unalias(tn.Type()).(*types.Named)
	if !ok {
		return "", false
	}
	for i := 0; i < named.NumMethods(); i++ {
		m := named.Method(i)
		if m.Name() != member {
			continue
		}
		id := domain.NodeID(pkg.PkgPath, typeName, member)
		if _, ok := nodeIndex[id]; ok {
			return id, true
		}
	}
	return "", false
}

// indexPackages builds a quick lookup from package path to live package.
// Packages without a Types value are skipped because the resolver cannot do
// anything useful with them.
func indexPackages(pkgs []parser.LivePackage) map[string]parser.LivePackage {
	out := make(map[string]parser.LivePackage, len(pkgs))
	for _, pkg := range pkgs {
		if pkg.Types == nil {
			continue
		}
		out[pkg.PkgPath] = pkg
	}
	return out
}

// indexNodes maps Node.ID → position in g.Nodes for O(1) Kind/Name lookups.
func indexNodes(nodes []domain.Node) map[string]int {
	out := make(map[string]int, len(nodes))
	for i := range nodes {
		out[nodes[i].ID] = i
	}
	return out
}

// indexImplementsEdges groups every implements-edge by its target so the
// resolver can answer "who implements interface X?" in constant time.
func indexImplementsEdges(edges []domain.Edge) map[string][]string {
	out := make(map[string][]string)
	for _, e := range edges {
		if e.Kind != domain.EdgeKindImplements {
			continue
		}
		out[e.Target] = append(out[e.Target], e.Source)
	}
	return out
}

// indexContainsEdges groups every contains-edge by its source so the
// resolver can list a struct's children (methods, fields) without walking
// the whole edge slice on every call.
func indexContainsEdges(edges []domain.Edge) map[string][]string {
	out := make(map[string][]string)
	for _, e := range edges {
		if e.Kind != domain.EdgeKindContains {
			continue
		}
		out[e.Source] = append(out[e.Source], e.Target)
	}
	return out
}

// InvalidEntryPointError is the error returned when one or more entry-point
// FQNs cannot be resolved. It embeds an *domain.APIError so the HTTP layer
// can serialise the canonical {code, message, details} envelope unchanged
// and chains domain.ErrInvalidEntryPoint so business code can match it
// through errors.Is.
type InvalidEntryPointError struct {
	*domain.APIError
}

// Unwrap returns domain.ErrInvalidEntryPoint so errors.Is(err,
// domain.ErrInvalidEntryPoint) succeeds for any value produced by this
// package.
func (e *InvalidEntryPointError) Unwrap() error { return domain.ErrInvalidEntryPoint }

// invalidEntryPoints wraps the offending FQNs in the canonical envelope
// described by api-contract.md §2.
func invalidEntryPoints(fqns []string) error {
	dedup := dedupStrings(fqns)
	return &InvalidEntryPointError{
		APIError: &domain.APIError{
			Code:       "invalid_entry_point",
			Message:    "one or more entry points could not be resolved",
			Details:    map[string]any{"fqns": dedup},
			HTTPStatus: 400,
		},
	}
}

// invalidSpec is the catch-all for shape errors on the spec itself (e.g. an
// unrecognised mode).
func invalidSpec(reason string) error {
	return &InvalidEntryPointError{
		APIError: &domain.APIError{
			Code:       "invalid_entry_point",
			Message:    reason,
			HTTPStatus: 400,
		},
	}
}

// dedupStrings returns in stripped of duplicates, preserving the original
// order of first appearance.
func dedupStrings(in []string) []string {
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if _, ok := seen[s]; ok {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	return out
}
