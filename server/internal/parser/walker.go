package parser

import (
	"go/token"
	"go/types"
	"sort"

	"golang.org/x/tools/go/packages"
)

// reduce walks a single packages.Package and returns its serialisable
// snapshot. The function is deterministic: scope members are processed in
// alphabetical order so the gob payload is reproducible across runs.
func reduce(pkg *packages.Package) *ReducedPackage {
	out := &ReducedPackage{
		PkgPath: pkg.PkgPath,
		Name:    pkg.Name,
		Imports: importPaths(pkg),
	}
	if pkg.Module != nil {
		out.Module = pkg.Module.Path
	}
	if pkg.Types == nil {
		return out
	}

	scope := pkg.Types.Scope()
	for _, name := range scope.Names() {
		obj := scope.Lookup(name)
		if obj == nil {
			continue
		}
		switch o := obj.(type) {
		case *types.TypeName:
			out.Types = append(out.Types, reduceTypeName(pkg, o))
		case *types.Func:
			out.Funcs = append(out.Funcs, reduceFunc(pkg, o, "" /* no receiver */))
		case *types.Var:
			out.Vars = append(out.Vars, reduceValue(pkg, o, "var"))
		case *types.Const:
			out.Consts = append(out.Consts, reduceValue(pkg, o, "const"))
		}
	}

	// Method sets are attached to their owning type rather than emitted at
	// the package level. Sort each type's methods for determinism.
	for i := range out.Types {
		sort.Slice(out.Types[i].Methods, func(a, b int) bool {
			return out.Types[i].Methods[a].Name < out.Types[i].Methods[b].Name
		})
	}
	return out
}

// importPaths returns the sorted, de-duplicated list of import paths declared
// by pkg. We use pkg.Imports (resolved) to match what go/types actually saw,
// not pkg.GoFiles which would require re-parsing.
func importPaths(pkg *packages.Package) []string {
	if len(pkg.Imports) == 0 {
		return nil
	}
	out := make([]string, 0, len(pkg.Imports))
	for path := range pkg.Imports {
		out = append(out, path)
	}
	sort.Strings(out)
	return out
}

// reduceTypeName converts a package-scope type declaration. The Kind field
// disambiguates structs, interfaces, aliases and "named" defined types.
func reduceTypeName(pkg *packages.Package, tn *types.TypeName) ReducedType {
	pos := pkg.Fset.Position(tn.Pos())
	rt := ReducedType{
		FQN:      pkg.PkgPath + "." + tn.Name(),
		Name:     tn.Name(),
		File:     pos.Filename,
		Line:     pos.Line,
		Exported: tn.Exported(),
		Kind:     classifyType(tn),
	}

	switch underlying := tn.Type().Underlying().(type) {
	case *types.Struct:
		rt.Fields, rt.Embedded = reduceStructFields(pkg, underlying)
	case *types.Interface:
		// Embedded interfaces are surfaced as referenced FQNs.
		for i := 0; i < underlying.NumEmbeddeds(); i++ {
			rt.Embedded = append(rt.Embedded, underlying.EmbeddedType(i).String())
		}
	}

	// Attach method set (value receiver methods only on the type itself; the
	// pointer receiver method set is queried by T09 directly).
	if named, ok := tn.Type().(*types.Named); ok {
		for i := 0; i < named.NumMethods(); i++ {
			rt.Methods = append(rt.Methods, reduceFunc(pkg, named.Method(i), tn.Name()))
		}
	}
	return rt
}

// classifyType inspects the underlying type and returns the canonical Kind
// string used by ReducedType.
func classifyType(tn *types.TypeName) string {
	if tn.IsAlias() {
		return "alias"
	}
	switch tn.Type().Underlying().(type) {
	case *types.Struct:
		return "struct"
	case *types.Interface:
		return "interface"
	default:
		return "named"
	}
}

// reduceStructFields splits regular fields from embedded ones. Embedded
// fields keep their TypeRef so downstream code can detect "type is embedded
// from X" patterns when building the implements relation (FR-09).
func reduceStructFields(pkg *packages.Package, st *types.Struct) ([]ReducedField, []string) {
	var fields []ReducedField
	var embedded []string
	for i := 0; i < st.NumFields(); i++ {
		f := st.Field(i)
		pos := pkg.Fset.Position(f.Pos())
		typeRef := f.Type().String()
		if f.Embedded() {
			embedded = append(embedded, typeRef)
			continue
		}
		fields = append(fields, ReducedField{
			Name:     f.Name(),
			TypeRef:  typeRef,
			Exported: f.Exported(),
			File:     pos.Filename,
			Line:     pos.Line,
		})
	}
	return fields, embedded
}

// reduceFunc converts a function or method object. recvName is empty for
// package-level functions and the receiver type's name for methods.
func reduceFunc(pkg *packages.Package, fn *types.Func, recvName string) ReducedFunc {
	pos := positionOf(pkg.Fset, fn.Pos())
	rf := ReducedFunc{
		Name:     fn.Name(),
		FQN:      methodFQN(pkg.PkgPath, recvName, fn.Name()),
		RecvType: recvName,
		File:     pos.Filename,
		Line:     pos.Line,
		IsMethod: recvName != "",
		Exported: fn.Exported(),
	}
	return rf
}

// reduceValue converts a package-level var or const.
func reduceValue(pkg *packages.Package, obj types.Object, kind string) ReducedValue {
	pos := positionOf(pkg.Fset, obj.Pos())
	return ReducedValue{
		FQN:      pkg.PkgPath + "." + obj.Name(),
		Name:     obj.Name(),
		Kind:     kind,
		File:     pos.Filename,
		Line:     pos.Line,
		Exported: obj.Exported(),
	}
}

// methodFQN renders a fully-qualified name in the canonical "pkg/path#Type.Method"
// form (or "pkg/path.Func" for free functions).
func methodFQN(pkgPath, recv, name string) string {
	if recv == "" {
		return pkgPath + "." + name
	}
	return pkgPath + "#" + recv + "." + name
}

// positionOf is a defensive wrapper around Fset.Position that tolerates a nil
// fileset (which can happen for synthetic objects).
func positionOf(fset *token.FileSet, pos token.Pos) token.Position {
	if fset == nil {
		return token.Position{}
	}
	return fset.Position(pos)
}
