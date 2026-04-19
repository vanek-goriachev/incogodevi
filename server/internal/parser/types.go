package parser

import (
	"encoding/gob"

	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// ReducedPackage is the serialisable snapshot of a single Go package. It
// carries everything the graph builder (T08) needs without holding a
// reference to the live go/types model. Slices are nil when empty so gob
// round-trips remain compact.
type ReducedPackage struct {
	PkgPath string
	Name    string
	Module  string
	Imports []string
	Types   []ReducedType
	Funcs   []ReducedFunc
	Vars    []ReducedValue
	Consts  []ReducedValue
}

// ReducedType describes a top-level named type. Kind distinguishes the
// possible flavours: "struct", "interface", "alias" or "named" (any other
// underlying type, e.g. a defined int).
type ReducedType struct {
	FQN      string
	Name     string
	Kind     string
	Fields   []ReducedField
	Methods  []ReducedFunc
	Embedded []string
	File     string
	Line     int
	Exported bool
}

// ReducedField is a single struct field. TypeRef is the textual
// representation of the field type, suitable for display and for cross-package
// lookups via FQN matching.
type ReducedField struct {
	Name     string
	TypeRef  string
	Exported bool
	File     string
	Line     int
}

// ReducedFunc captures a top-level function or a method bound to a named
// receiver type. RecvType is empty for plain functions; IsMethod is true when
// RecvType refers to a named type in the same module.
type ReducedFunc struct {
	FQN      string
	Name     string
	RecvType string
	File     string
	Line     int
	IsMethod bool
	Exported bool
}

// ReducedValue captures a package-level var or const.
type ReducedValue struct {
	FQN      string
	Name     string
	Kind     string
	File     string
	Line     int
	Exported bool
}

// blobSchemaVersion is the parser-local cache schema. It is bumped
// independently of domain.CurrentSchemaVersion because changes to the gob
// layout do not necessarily imply changes to the rest of the API surface.
// A mismatch makes ReadParsedBlob behave like a cache miss.
const blobSchemaVersion = 1

// blobEnvelope is the on-disk gob frame: a version header followed by the
// reduced package list. Decoding into this struct lets callers detect schema
// drift before touching the heavy payload.
type blobEnvelope struct {
	SchemaVersion int
	Packages      []ReducedPackage
}

// LoadResult is the value returned by Parser.Load. Packages is always set;
// LivePackages is only populated when Load actually invoked packages.Load
// (i.e. on a cache miss). When TypesUnavailable is true the caller must
// rebuild from sources if it needs go/types information (e.g. T09
// types.Implements).
type LoadResult struct {
	Packages         []*ReducedPackage
	LivePackages     []livePackage
	Warnings         []domain.Warning
	ElapsedMS        int
	TypesUnavailable bool
	FromCache        bool
}

// init wires the gob registry. The cache file is written in our own format
// but registering the concrete types up-front guards against typed nil
// surprises when the slices are encoded as part of an interface.
func init() {
	gob.Register(ReducedPackage{})
	gob.Register(ReducedType{})
	gob.Register(ReducedFunc{})
	gob.Register(ReducedField{})
	gob.Register(ReducedValue{})
}
