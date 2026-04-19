package graph

import (
	"context"
	"go/types"
	"log/slog"
	"sort"

	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
	"github.com/vanek-goriachev/incogodevi/server/internal/parser"
)

// ImplementsResolver derives "implements" edges from the live type-aware view
// of a project. It implements the design recorded in ADR-05: pair every named
// type with every project-local interface and consult types.Implements with a
// pointer receiver so methods declared on *T are honoured. Type aliases are
// unwrapped via types.Unalias before comparison; embedding is handled
// transparently by go/types' method-set computation.
type ImplementsResolver struct {
	logger *slog.Logger
}

// NewImplementsResolver constructs a resolver. A nil logger falls back to
// slog.Default().
func NewImplementsResolver(logger *slog.Logger) *ImplementsResolver {
	if logger == nil {
		logger = slog.Default()
	}
	return &ImplementsResolver{logger: logger}
}

// Resolve walks pkgs and emits one implements-edge per (T, I) pair where
// types.Implements(types.NewPointer(T), I) holds.
//
// Only project-local interfaces are considered; any I owned by a package
// outside pkgs is skipped to avoid flooding the graph with edges to stdlib
// or third-party interfaces such as io.Reader (FR-09 acceptance).
//
// nodesByTypeFQN maps a canonical type FQN ("<pkg>#<TypeName>") to its
// existing Node.ID. Edges are only emitted when both endpoints are present
// in the map; this keeps the resolver in lock-step with the GraphBuilder
// without re-deriving identifiers.
//
// The progress channel, when non-nil, receives monotonically non-decreasing
// values in [0.0, 1.0] and is closed before Resolve returns. The denominator
// is the total pair count (|T|·|I|); a count of zero emits a single 1.0.
func (r *ImplementsResolver) Resolve(
	ctx context.Context,
	pkgs []parser.LivePackage,
	nodesByTypeFQN map[string]string,
	progress chan<- float64,
) ([]domain.Edge, error) {
	if progress != nil {
		defer close(progress)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	projectPkgs := projectPackagePaths(pkgs)
	namedTypes := collectNamedTypes(pkgs)
	interfaces := collectProjectInterfaces(pkgs, projectPkgs)

	emit(progress, 0.0)
	total := len(namedTypes) * len(interfaces)
	if total == 0 {
		emit(progress, 1.0)
		return nil, nil
	}

	seen := make(map[string]struct{}, len(namedTypes))
	out := make([]domain.Edge, 0, len(namedTypes))

	processed := 0
	for _, t := range namedTypes {
		if err := ctx.Err(); err != nil {
			return nil, err
		}

		// Skip interface types: interface->interface relationships are
		// already represented as embeds-edges by T08.
		if _, isIface := t.named.Underlying().(*types.Interface); isIface {
			processed += len(interfaces)
			emit(progress, float64(processed)/float64(total))
			continue
		}

		ptrT := types.NewPointer(t.named)
		for _, iface := range interfaces {
			processed++
			if t.fqn == iface.fqn {
				continue
			}
			if !types.Implements(ptrT, iface.iface) {
				continue
			}
			srcID, ok := nodesByTypeFQN[t.fqn]
			if !ok {
				continue
			}
			tgtID, ok := nodesByTypeFQN[iface.fqn]
			if !ok {
				continue
			}
			edgeID := domain.EdgeID(srcID, tgtID, domain.EdgeKindImplements)
			if _, dup := seen[edgeID]; dup {
				continue
			}
			seen[edgeID] = struct{}{}
			out = append(out, domain.Edge{
				ID:     edgeID,
				Source: srcID,
				Target: tgtID,
				Kind:   domain.EdgeKindImplements,
				Weight: 1,
			})
		}
		emit(progress, float64(processed)/float64(total))
	}

	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Source != out[j].Source {
			return out[i].Source < out[j].Source
		}
		return out[i].Target < out[j].Target
	})

	r.logger.Debug("graph: implements resolved",
		slog.Int("named_types", len(namedTypes)),
		slog.Int("project_interfaces", len(interfaces)),
		slog.Int("edges", len(out)))

	return out, nil
}

// namedTypeRef pairs a named type with its canonical FQN so the inner loop
// avoids recomputing the package/name on every comparison.
type namedTypeRef struct {
	fqn   string
	named *types.Named
}

// interfaceRef pairs an interface type with its FQN for the same reason.
type interfaceRef struct {
	fqn   string
	iface *types.Interface
}

// projectPackagePaths collects the set of package paths owned by the project,
// used to filter out stdlib and third-party interfaces.
func projectPackagePaths(pkgs []parser.LivePackage) map[string]struct{} {
	out := make(map[string]struct{}, len(pkgs))
	for _, pkg := range pkgs {
		if pkg.Types == nil {
			continue
		}
		out[pkg.PkgPath] = struct{}{}
	}
	return out
}

// collectNamedTypes returns every package-scope *types.Named declared in
// pkgs. The slice is sorted by FQN so the resolver output is deterministic
// across runs.
func collectNamedTypes(pkgs []parser.LivePackage) []namedTypeRef {
	var out []namedTypeRef
	for _, pkg := range pkgs {
		if pkg.Types == nil {
			continue
		}
		scope := pkg.Types.Scope()
		for _, name := range scope.Names() {
			tn, ok := scope.Lookup(name).(*types.TypeName)
			if !ok {
				continue
			}
			named, ok := types.Unalias(tn.Type()).(*types.Named)
			if !ok || named.Obj() == nil || named.Obj().Pkg() == nil {
				continue
			}
			out = append(out, namedTypeRef{
				fqn:   typeFQN(named.Obj().Pkg().Path(), tn.Name()),
				named: named,
			})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].fqn < out[j].fqn })
	return out
}

// collectProjectInterfaces walks pkgs and returns every non-empty interface
// declared in a project-local package. Empty interfaces (such as `any`) are
// excluded because they would generate an edge from every named type, which
// is noise rather than signal.
func collectProjectInterfaces(pkgs []parser.LivePackage, projectPkgs map[string]struct{}) []interfaceRef {
	var out []interfaceRef
	for _, pkg := range pkgs {
		if pkg.Types == nil {
			continue
		}
		scope := pkg.Types.Scope()
		for _, name := range scope.Names() {
			tn, ok := scope.Lookup(name).(*types.TypeName)
			if !ok {
				continue
			}
			t := types.Unalias(tn.Type())
			named, ok := t.(*types.Named)
			if !ok {
				continue
			}
			iface, ok := named.Underlying().(*types.Interface)
			if !ok {
				continue
			}
			if iface.NumMethods() == 0 {
				continue
			}
			pkgObj := named.Obj().Pkg()
			if pkgObj == nil {
				continue
			}
			if _, isLocal := projectPkgs[pkgObj.Path()]; !isLocal {
				continue
			}
			out = append(out, interfaceRef{
				fqn:   typeFQN(pkgObj.Path(), tn.Name()),
				iface: iface,
			})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].fqn < out[j].fqn })
	return out
}

// typeFQN renders the canonical FQN used as the key in
// ImplementsResolver.Resolve's nodesByTypeFQN argument. The format mirrors
// the canonical form used by domain.NodeID for type-level nodes
// ("<pkg>#<TypeName>") so that callers can build the index directly from
// the *types.TypeName objects they already track.
func typeFQN(pkgPath, typeName string) string {
	return pkgPath + "#" + typeName
}
