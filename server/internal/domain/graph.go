package domain

// GraphStats summarises the contents of a Graph for quick UI consumption and
// for /graph response bodies.
type GraphStats struct {
	NodeCount int              `json:"node_count"`
	EdgeCount int              `json:"edge_count"`
	DeadCount int              `json:"dead_count"`
	ByKind    map[NodeKind]int `json:"by_kind"`
}

// Graph is the central artifact produced by the analysis pipeline.
//
// SchemaVersion is stamped from CurrentSchemaVersion at construction time so
// that on-disk caches can be invalidated when the structure evolves (ADR-12).
type Graph struct {
	Nodes         []Node     `json:"nodes"`
	Edges         []Edge     `json:"edges"`
	Warnings      []Warning  `json:"warnings"`
	Stats         GraphStats `json:"stats"`
	SchemaVersion int        `json:"schema_version"`
}
