package graph

import (
	"context"
	"fmt"
	"go/token"
	"go/types"
	"log/slog"
	"sort"
	"unicode"

	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
	"github.com/vanek-goriachev/incogodevi/server/internal/parser"
)

// Builder converts a parser.LoadResult into a domain.Graph. Instances are
// safe for concurrent use across distinct BuildInput values; the per-call
// state lives entirely on the stack.
type Builder struct {
	logger *slog.Logger
}

// New constructs a Builder. Logger may be nil; callers that omit it get
// slog.Default().
func New(logger *slog.Logger) *Builder {
	if logger == nil {
		logger = slog.Default()
	}
	return &Builder{logger: logger}
}

// BuildInput is the union of the two parser views consumed by Build. Packages
// carries the live, type-aware projection required for call-edge extraction
// and embedding analysis. Reduced is the serialisable mirror that supplies
// stable file/line metadata even when the live view is unavailable.
type BuildInput struct {
	Packages []parser.LivePackage
	Reduced  []*parser.ReducedPackage
}

// Build walks every input package and emits a populated Graph. Progress, when
// non-nil, receives monotonically non-decreasing values in [0.0, 1.0] and is
// closed when Build returns. The reachability and entry-point flags on each
// node are intentionally left zero; T10 and T11 fill them in.
func (b *Builder) Build(ctx context.Context, in BuildInput, progress chan<- float64) (*domain.Graph, error) {
	if progress != nil {
		defer close(progress)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	state := newBuildState()
	pkgs := sortLive(in.Packages)
	emit(progress, 0.0)

	if len(pkgs) == 0 {
		emit(progress, 1.0)
		g := state.finalize()
		return g, nil
	}

	for i, pkg := range pkgs {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if err := state.addPackage(pkg); err != nil {
			return nil, fmt.Errorf("graph: package %q: %w", pkg.PkgPath, err)
		}
		emit(progress, float64(i+1)/float64(len(pkgs)))
	}

	for _, w := range state.warnings {
		b.logger.Debug("graph: build warning",
			slog.String("code", w.Code),
			slog.String("package", w.Package),
			slog.String("message", w.Message))
	}

	// Cross-package edges (imports, calls, references) require every package
	// node to exist first, hence the second pass.
	for _, pkg := range pkgs {
		state.addImports(pkg)
		state.addCallsAndReferences(pkg)
	}

	if err := b.resolveImplements(ctx, pkgs, state); err != nil {
		return nil, err
	}

	return state.finalize(), nil
}

// resolveImplements runs the ImplementsResolver against the live packages and
// merges the resulting edges into state. Pre-existing implements-edges from
// earlier passes (currently none) are deduplicated by edgeKey.
func (b *Builder) resolveImplements(ctx context.Context, pkgs []parser.LivePackage, state *buildState) error {
	resolver := NewImplementsResolver(b.logger)
	edges, err := resolver.Resolve(ctx, pkgs, state.typeFQNIndex(), nil)
	if err != nil {
		return fmt.Errorf("graph: implements resolver: %w", err)
	}
	for _, e := range edges {
		state.addEdge(e.Source, e.Target, domain.EdgeKindImplements)
	}
	return nil
}

// sortLive returns a copy of pkgs ordered by PkgPath so that the produced
// Graph is deterministic.
func sortLive(pkgs []parser.LivePackage) []parser.LivePackage {
	out := make([]parser.LivePackage, len(pkgs))
	copy(out, pkgs)
	sort.Slice(out, func(i, j int) bool { return out[i].PkgPath < out[j].PkgPath })
	return out
}

// emit forwards v on progress when the channel is non-nil. Sends are
// blocking; callers are expected to size the channel generously.
func emit(progress chan<- float64, v float64) {
	if progress == nil {
		return
	}
	progress <- v
}

// buildState accumulates nodes, edges and warnings across the two-pass walk.
// All maps are keyed by Node.ID / canonical edge tuples to keep duplicates
// from sneaking in when the same object is observed from multiple angles.
type buildState struct {
	nodes     []domain.Node
	nodeIndex map[string]int
	edges     map[edgeKey]*domain.Edge
	edgeOrder []edgeKey
	warnings  []domain.Warning

	// funcByObj maps a *types.Func to the node ID we minted for it. The
	// call-edge pass uses this to translate types.Object back into Node.ID
	// without rederiving the canonical name.
	funcByObj map[*types.Func]string

	// varByObj / constByObj / typeByObj fulfil the same role for the
	// references pass.
	varByObj   map[*types.Var]string
	constByObj map[*types.Const]string
	typeByObj  map[*types.TypeName]string

	// ownerByPkg maps a package path to its Node.ID so cross-package edges
	// (imports) can resolve quickly.
	pkgID map[string]string
}

// edgeKey is the dedup key for edges: (source, target, kind). Equal keys are
// merged and their Weight incremented (FR-08).
type edgeKey struct {
	Src  string
	Tgt  string
	Kind domain.EdgeKind
}

func newBuildState() *buildState {
	return &buildState{
		nodeIndex:  make(map[string]int),
		edges:      make(map[edgeKey]*domain.Edge),
		funcByObj:  make(map[*types.Func]string),
		varByObj:   make(map[*types.Var]string),
		constByObj: make(map[*types.Const]string),
		typeByObj:  make(map[*types.TypeName]string),
		pkgID:      make(map[string]string),
	}
}

// addPackage materialises every node owned by pkg and the contains-edges that
// link them. Nothing here crosses package boundaries; cross-package wiring
// happens in addImports / addCallsAndReferences.
func (s *buildState) addPackage(pkg parser.LivePackage) error {
	if pkg.Types == nil {
		s.warnings = append(s.warnings, domain.Warning{
			Code:    "graph_skip_no_types",
			Message: "package has no type information; skipped",
			Package: pkg.PkgPath,
		})
		return nil
	}

	pkgNode := domain.Node{
		ID:       domain.NodeID(pkg.PkgPath, "", ""),
		Name:     pkg.Name,
		Kind:     domain.NodeKindPackage,
		Package:  pkg.PkgPath,
		Exported: true,
	}
	s.upsertNode(pkgNode)
	s.pkgID[pkg.PkgPath] = pkgNode.ID

	scope := pkg.Types.Scope()
	for _, name := range scope.Names() {
		obj := scope.Lookup(name)
		if obj == nil {
			continue
		}
		switch o := obj.(type) {
		case *types.TypeName:
			s.addTypeName(pkg, pkgNode.ID, o)
		case *types.Func:
			s.addFunc(pkg, pkgNode.ID, o, "")
		case *types.Var:
			s.addVar(pkg, pkgNode.ID, o)
		case *types.Const:
			s.addConst(pkg, pkgNode.ID, o)
		}
	}
	return nil
}

// addTypeName produces a struct/interface node (or a generic "named" node for
// anything else) plus its child fields, methods and embed-edges.
func (s *buildState) addTypeName(pkg parser.LivePackage, pkgNodeID string, tn *types.TypeName) {
	typeName := tn.Name()
	pos := position(pkg.Fset, tn.Pos())

	kind := classifyTypeKind(tn)
	node := domain.Node{
		ID:       domain.NodeID(pkg.PkgPath, typeName, ""),
		Name:     typeName,
		Kind:     kind,
		Package:  pkg.PkgPath,
		File:     pos.Filename,
		Line:     pos.Line,
		Exported: tn.Exported(),
	}
	s.upsertNode(node)
	s.typeByObj[tn] = node.ID
	s.addContains(pkgNodeID, node.ID)

	// Methods: attach to the named type via contains-edges. Methods are
	// emitted regardless of kind so interface methods are visible too.
	if named, ok := types.Unalias(tn.Type()).(*types.Named); ok {
		for i := 0; i < named.NumMethods(); i++ {
			s.addFunc(pkg, node.ID, named.Method(i), typeName)
		}
	}

	switch underlying := tn.Type().Underlying().(type) {
	case *types.Struct:
		s.addStructFields(pkg, node.ID, typeName, underlying)
	case *types.Interface:
		s.addInterfaceEmbeds(node.ID, underlying)
	}
}

// addStructFields emits a field node per non-embedded field and an
// embeds-edge for every embedded one.
func (s *buildState) addStructFields(pkg parser.LivePackage, parentID, typeName string, st *types.Struct) {
	for i := 0; i < st.NumFields(); i++ {
		f := st.Field(i)
		pos := position(pkg.Fset, f.Pos())
		if f.Embedded() {
			if targetID := embeddedTargetID(f.Type()); targetID != "" {
				s.addEdge(parentID, targetID, domain.EdgeKindEmbeds)
			}
			continue
		}
		fieldNode := domain.Node{
			ID:       domain.NodeID(pkg.PkgPath, typeName, f.Name()),
			Name:     f.Name(),
			Kind:     domain.NodeKindField,
			Package:  pkg.PkgPath,
			File:     pos.Filename,
			Line:     pos.Line,
			Exported: f.Exported(),
		}
		s.upsertNode(fieldNode)
		s.varByObj[f] = fieldNode.ID
		s.addContains(parentID, fieldNode.ID)
	}
}

// addInterfaceEmbeds wires an embeds-edge for each named type embedded in
// the interface (e.g. `interface { io.Reader }`).
func (s *buildState) addInterfaceEmbeds(parentID string, iface *types.Interface) {
	for i := 0; i < iface.NumEmbeddeds(); i++ {
		if targetID := embeddedTargetID(iface.EmbeddedType(i)); targetID != "" {
			s.addEdge(parentID, targetID, domain.EdgeKindEmbeds)
		}
	}
}

// addFunc creates a func or method node owned by parentID. recvName is empty
// for free functions and the receiver type's name for methods (it determines
// both the canonical NodeID and the NodeKind).
func (s *buildState) addFunc(pkg parser.LivePackage, parentID string, fn *types.Func, recvName string) {
	pos := position(pkg.Fset, fn.Pos())

	kind := domain.NodeKindFunc
	if recvName != "" || receiverName(fn) != "" {
		kind = domain.NodeKindMethod
		if recvName == "" {
			recvName = receiverName(fn)
		}
	}

	node := domain.Node{
		ID:       domain.NodeID(pkg.PkgPath, recvName, fn.Name()),
		Name:     fn.Name(),
		Kind:     kind,
		Package:  pkg.PkgPath,
		File:     pos.Filename,
		Line:     pos.Line,
		Exported: isExportedName(fn.Name()),
	}
	s.upsertNode(node)
	s.funcByObj[fn] = node.ID
	s.addContains(parentID, node.ID)
}

// addVar registers a package-level variable. Local variables are out of
// scope for the MVP graph (ADR-07).
func (s *buildState) addVar(pkg parser.LivePackage, pkgNodeID string, v *types.Var) {
	pos := position(pkg.Fset, v.Pos())
	node := domain.Node{
		ID:       domain.NodeID(pkg.PkgPath, "", v.Name()),
		Name:     v.Name(),
		Kind:     domain.NodeKindVar,
		Package:  pkg.PkgPath,
		File:     pos.Filename,
		Line:     pos.Line,
		Exported: v.Exported(),
	}
	s.upsertNode(node)
	s.varByObj[v] = node.ID
	s.addContains(pkgNodeID, node.ID)
}

// addConst registers a package-level constant.
func (s *buildState) addConst(pkg parser.LivePackage, pkgNodeID string, c *types.Const) {
	pos := position(pkg.Fset, c.Pos())
	node := domain.Node{
		ID:       domain.NodeID(pkg.PkgPath, "", c.Name()),
		Name:     c.Name(),
		Kind:     domain.NodeKindConst,
		Package:  pkg.PkgPath,
		File:     pos.Filename,
		Line:     pos.Line,
		Exported: c.Exported(),
	}
	s.upsertNode(node)
	s.constByObj[c] = node.ID
	s.addContains(pkgNodeID, node.ID)
}

// addImports wires one imports-edge per direct dependency that has been seen
// during the first pass. Imports of stdlib or external packages are ignored
// because their Node never gets created.
func (s *buildState) addImports(pkg parser.LivePackage) {
	if pkg.Types == nil {
		return
	}
	srcID, ok := s.pkgID[pkg.PkgPath]
	if !ok {
		return
	}
	for _, imp := range pkg.Types.Imports() {
		if imp == nil {
			continue
		}
		if tgtID, ok := s.pkgID[imp.Path()]; ok {
			s.addEdge(srcID, tgtID, domain.EdgeKindImports)
		}
	}
}

// upsertNode appends node when its ID is fresh. Repeated calls with the same
// ID are a no-op so the addPackage / cross-package passes remain idempotent.
func (s *buildState) upsertNode(node domain.Node) {
	if _, ok := s.nodeIndex[node.ID]; ok {
		return
	}
	s.nodeIndex[node.ID] = len(s.nodes)
	s.nodes = append(s.nodes, node)
}

// addContains is a thin shortcut for the common "package contains symbol"
// pattern. It keeps the call sites readable.
func (s *buildState) addContains(parentID, childID string) {
	s.addEdge(parentID, childID, domain.EdgeKindContains)
}

// addEdge inserts a fresh edge or, when the (src,tgt,kind) tuple has already
// been seen, increments its weight. Weight starts at 1 for the first
// occurrence; the dedup'ed counter doubles as a frequency hint for renderers.
func (s *buildState) addEdge(src, tgt string, kind domain.EdgeKind) {
	if src == "" || tgt == "" {
		return
	}
	key := edgeKey{Src: src, Tgt: tgt, Kind: kind}
	if existing, ok := s.edges[key]; ok {
		existing.Weight++
		return
	}
	s.edges[key] = &domain.Edge{
		ID:     domain.EdgeID(src, tgt, kind),
		Source: src,
		Target: tgt,
		Kind:   kind,
		Weight: 1,
	}
	s.edgeOrder = append(s.edgeOrder, key)
}

// typeFQNIndex projects typeByObj into the FQN-keyed map expected by the
// ImplementsResolver. Keys mirror the canonical form used by domain.NodeID
// for type-level nodes ("<pkg>#<TypeName>").
func (s *buildState) typeFQNIndex() map[string]string {
	out := make(map[string]string, len(s.typeByObj))
	for tn, id := range s.typeByObj {
		if tn == nil || tn.Pkg() == nil {
			continue
		}
		out[typeFQN(tn.Pkg().Path(), tn.Name())] = id
	}
	return out
}

// finalize materialises the accumulated state into a domain.Graph. Edges and
// warnings are returned in a deterministic order; nodes preserve their
// insertion order which is itself stable thanks to sortLive + alphabetical
// scope traversal.
func (s *buildState) finalize() *domain.Graph {
	edges := make([]domain.Edge, 0, len(s.edgeOrder))
	for _, key := range s.edgeOrder {
		edges = append(edges, *s.edges[key])
	}
	sort.SliceStable(edges, func(i, j int) bool {
		if edges[i].Source != edges[j].Source {
			return edges[i].Source < edges[j].Source
		}
		if edges[i].Target != edges[j].Target {
			return edges[i].Target < edges[j].Target
		}
		return edges[i].Kind < edges[j].Kind
	})

	stats := domain.GraphStats{
		NodeCount: len(s.nodes),
		EdgeCount: len(edges),
		ByKind:    countByKind(s.nodes),
	}
	return &domain.Graph{
		Nodes:         append([]domain.Node(nil), s.nodes...),
		Edges:         edges,
		Warnings:      append([]domain.Warning(nil), s.warnings...),
		Stats:         stats,
		SchemaVersion: domain.CurrentSchemaVersion,
	}
}

// countByKind returns a fresh map populated with one entry per known
// NodeKind so consumers can rely on the keys existing even when the count
// is zero.
func countByKind(nodes []domain.Node) map[domain.NodeKind]int {
	out := make(map[domain.NodeKind]int, len(domain.AllNodeKinds))
	for _, k := range domain.AllNodeKinds {
		out[k] = 0
	}
	for i := range nodes {
		out[nodes[i].Kind]++
	}
	return out
}

// classifyTypeKind maps a TypeName to a NodeKind. Aliases are unwrapped to
// the underlying named type so e.g. `type FooAlias = Foo` still produces a
// struct/interface node.
func classifyTypeKind(tn *types.TypeName) domain.NodeKind {
	t := types.Unalias(tn.Type())
	switch t.Underlying().(type) {
	case *types.Struct:
		return domain.NodeKindStruct
	case *types.Interface:
		return domain.NodeKindInterface
	default:
		return domain.NodeKindStruct
	}
}

// embeddedTargetID returns the NodeID of the target of an embed relation
// (struct embed or interface embed) or "" when the target is anonymous.
//
// The function intentionally accepts both *types.Named and *types.Pointer so
// that `struct { *Inner }` resolves to the same node as `struct { Inner }`.
func embeddedTargetID(t types.Type) string {
	t = types.Unalias(t)
	if ptr, ok := t.(*types.Pointer); ok {
		t = ptr.Elem()
	}
	named, ok := t.(*types.Named)
	if !ok {
		return ""
	}
	obj := named.Obj()
	if obj == nil || obj.Pkg() == nil {
		return ""
	}
	return domain.NodeID(obj.Pkg().Path(), obj.Name(), "")
}

// receiverName extracts the bare name of fn's receiver type, stripping any
// pointer indirection. Free functions return "".
func receiverName(fn *types.Func) string {
	sig, ok := fn.Type().(*types.Signature)
	if !ok || sig.Recv() == nil {
		return ""
	}
	t := sig.Recv().Type()
	if ptr, ok := t.(*types.Pointer); ok {
		t = ptr.Elem()
	}
	t = types.Unalias(t)
	if named, ok := t.(*types.Named); ok && named.Obj() != nil {
		return named.Obj().Name()
	}
	return ""
}

// isExportedName mirrors token.IsExported without pulling in the heavier
// dependency. We rely on the rune-level check because *types.Func.Exported
// agrees with this convention.
func isExportedName(name string) bool {
	if name == "" {
		return false
	}
	r := []rune(name)[0]
	return unicode.IsUpper(r)
}

// position is a defensive wrapper around Fset.Position that tolerates a nil
// fileset (e.g. for synthetic objects built outside the parser).
func position(fset *token.FileSet, pos token.Pos) token.Position {
	if fset == nil || !pos.IsValid() {
		return token.Position{}
	}
	return fset.Position(pos)
}
