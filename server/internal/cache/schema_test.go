package cache_test

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/vanek-goriachev/incogodevi/server/internal/cache"
	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// staleEnvelope mirrors the on-disk layout of graph.json / dead-code.json so
// the test can craft documents with arbitrary SchemaVersion values.
type staleEnvelope struct {
	SchemaVersion int            `json:"schema_version"`
	Graph         map[string]any `json:"graph,omitempty"`
	Report        map[string]any `json:"report,omitempty"`
}

func TestReadGraphRejectsSchemaMismatch(t *testing.T) {
	mgr := newTestManager(t)
	project, err := mgr.NewProject("ex", 0, 0)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	env := staleEnvelope{
		SchemaVersion: domain.CurrentSchemaVersion + 1,
		Graph:         map[string]any{"nodes": []any{}, "edges": []any{}, "warnings": []any{}, "stats": map[string]any{}, "schema_version": domain.CurrentSchemaVersion + 1},
	}
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	if err := os.WriteFile(filepath.Join(project.CacheDir, "graph.json"), raw, 0o600); err != nil {
		t.Fatalf("write stale graph: %v", err)
	}
	if _, err := mgr.ReadGraph(project.Meta.ID); !errors.Is(err, cache.ErrSchemaMismatch) {
		t.Fatalf("ReadGraph = %v, want ErrSchemaMismatch", err)
	}
}

func TestReadDeadCodeRejectsSchemaMismatch(t *testing.T) {
	mgr := newTestManager(t)
	project, err := mgr.NewProject("ex", 0, 0)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	env := staleEnvelope{
		SchemaVersion: domain.CurrentSchemaVersion + 5,
		Report:        map[string]any{"project_id": string(project.Meta.ID), "generated_at": "2026-04-19T10:00:00Z", "entries_count": 0, "entries": []any{}},
	}
	raw, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	if err := os.WriteFile(filepath.Join(project.CacheDir, "dead-code.json"), raw, 0o600); err != nil {
		t.Fatalf("write stale dead-code: %v", err)
	}
	if _, err := mgr.ReadDeadCode(project.Meta.ID); !errors.Is(err, cache.ErrSchemaMismatch) {
		t.Fatalf("ReadDeadCode = %v, want ErrSchemaMismatch", err)
	}
}

func TestReadMetaRejectsSchemaMismatch(t *testing.T) {
	mgr := newTestManager(t)
	project, err := mgr.NewProject("ex", 0, 0)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	stale := map[string]any{
		"id":             string(project.Meta.ID),
		"name":           project.Meta.Name,
		"uploaded_at":    project.Meta.UploadedAt,
		"last_access_at": project.Meta.LastAccessAt,
		"expires_at":     project.Meta.ExpiresAt,
		"size_bytes":     0,
		"file_count":     0,
		"schema_version": domain.CurrentSchemaVersion + 7,
	}
	raw, err := json.Marshal(stale)
	if err != nil {
		t.Fatalf("marshal stale meta: %v", err)
	}
	if err := os.WriteFile(filepath.Join(project.CacheDir, "meta.json"), raw, 0o600); err != nil {
		t.Fatalf("write stale meta: %v", err)
	}
	if _, err := mgr.ReadMeta(project.Meta.ID); !errors.Is(err, cache.ErrSchemaMismatch) {
		t.Fatalf("ReadMeta = %v, want ErrSchemaMismatch", err)
	}
}

func TestReadGraphRejectsEmptyEnvelope(t *testing.T) {
	mgr := newTestManager(t)
	project, err := mgr.NewProject("ex", 0, 0)
	if err != nil {
		t.Fatalf("NewProject: %v", err)
	}
	raw, err := json.Marshal(staleEnvelope{SchemaVersion: domain.CurrentSchemaVersion})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(filepath.Join(project.CacheDir, "graph.json"), raw, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := mgr.ReadGraph(project.Meta.ID); !errors.Is(err, cache.ErrStaleCache) {
		t.Fatalf("ReadGraph = %v, want ErrStaleCache", err)
	}
}
