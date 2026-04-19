package cache

import "errors"

// Sentinel errors raised by the cache package. They are wrapped with
// fmt.Errorf("...: %w", err) by callers and inspected via errors.Is.
var (
	// ErrSchemaMismatch — the artifact on disk was written by a different
	// schema version than domain.CurrentSchemaVersion. Callers should treat
	// the cached value as missing and rebuild it.
	ErrSchemaMismatch = errors.New("schema version mismatch")

	// ErrStaleCache — the cached artifact is unreadable or structurally
	// invalid (e.g. malformed JSON, truncated file). Callers should treat it
	// as missing and rebuild it.
	ErrStaleCache = errors.New("stale cache")

	// ErrManagerClosed — Manager.Close has already been called and the
	// instance must not be used further.
	ErrManagerClosed = errors.New("cache manager closed")
)
