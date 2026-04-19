package web

import (
	"io"
	"io/fs"
	"strings"
	"testing"
)

func TestDistFS_HasIndex(t *testing.T) {
	t.Parallel()

	root := DistFS()
	f, err := root.Open("index.html")
	if err != nil {
		t.Fatalf("open index.html: %v", err)
	}
	t.Cleanup(func() { _ = f.Close() })
	body, err := io.ReadAll(f)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !strings.Contains(string(body), "<!doctype html>") {
		t.Errorf("placeholder index missing doctype: %s", body)
	}
}

func TestDistFS_NoStrayFiles(t *testing.T) {
	t.Parallel()

	root := DistFS()
	var entries []string
	err := fs.WalkDir(root, ".", func(path string, _ fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		entries = append(entries, path)
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	// Sanity check: at least the root and index.html must be present.
	if len(entries) < 2 {
		t.Errorf("dist tree should not be empty, got %v", entries)
	}
}
