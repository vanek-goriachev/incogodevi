package parser

import (
	"go/token"
	"go/types"

	"golang.org/x/tools/go/packages"
)

// livePackage carries the non-serialisable, type-aware view of a package
// alongside the reduced snapshot. T08/T09 consume it directly; the cache
// layer never sees it.
type livePackage struct {
	PkgPath   string
	Name      string
	Types     *types.Package
	TypesInfo *types.Info
	Fset      *token.FileSet
}

// fromPackages converts a packages.Package into the lighter livePackage
// projection. Returning a struct rather than aliasing the upstream type lets
// us keep the public API stable even if x/tools changes its struct layout.
func fromPackages(p *packages.Package) livePackage {
	return livePackage{
		PkgPath:   p.PkgPath,
		Name:      p.Name,
		Types:     p.Types,
		TypesInfo: p.TypesInfo,
		Fset:      p.Fset,
	}
}
