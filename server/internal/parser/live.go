package parser

import (
	"go/ast"
	"go/token"
	"go/types"

	"golang.org/x/tools/go/packages"
)

// LivePackage carries the non-serialisable, type-aware view of a package
// alongside the reduced snapshot. T08 (graph builder) and T09 (interface
// resolver) consume it directly; the cache layer never sees it because the
// embedded *types.Package and *ast.File pointers are not serialisable.
type LivePackage struct {
	PkgPath   string
	Name      string
	Types     *types.Package
	TypesInfo *types.Info
	Fset      *token.FileSet
	Syntax    []*ast.File
}

// fromPackages converts a packages.Package into the lighter LivePackage
// projection. Returning a struct rather than aliasing the upstream type lets
// us keep the public API stable even if x/tools changes its struct layout.
func fromPackages(p *packages.Package) LivePackage {
	return LivePackage{
		PkgPath:   p.PkgPath,
		Name:      p.Name,
		Types:     p.Types,
		TypesInfo: p.TypesInfo,
		Fset:      p.Fset,
		Syntax:    p.Syntax,
	}
}
