package cache

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// scanTempLeftovers returns the names of any sibling .tmp-* files left behind
// by writeAtomic / atomicWriteCloser cleanup paths.
func scanTempLeftovers(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read dir %s: %v", dir, err)
	}
	var leftovers []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".tmp-") {
			leftovers = append(leftovers, e.Name())
		}
	}
	return leftovers
}

func TestWriteAtomicHappyPath(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "out.txt")
	if err := writeAtomic(target, func(w io.Writer) error {
		_, err := w.Write([]byte("hello"))
		return err
	}); err != nil {
		t.Fatalf("writeAtomic: %v", err)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read target: %v", err)
	}
	if string(got) != "hello" {
		t.Errorf("file contents = %q, want %q", got, "hello")
	}
	if leftovers := scanTempLeftovers(t, dir); len(leftovers) != 0 {
		t.Errorf("leftover temp files: %v", leftovers)
	}
}

func TestWriteAtomicCallbackErrorRemovesTemp(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "out.txt")
	wantErr := errors.New("boom")
	err := writeAtomic(target, func(w io.Writer) error {
		_, _ = w.Write([]byte("partial"))
		return wantErr
	})
	if !errors.Is(err, wantErr) {
		t.Fatalf("writeAtomic err = %v, want wraps %v", err, wantErr)
	}
	if _, err := os.Stat(target); !os.IsNotExist(err) {
		t.Errorf("target should not exist: stat err = %v", err)
	}
	if leftovers := scanTempLeftovers(t, dir); len(leftovers) != 0 {
		t.Errorf("leftover temp files: %v", leftovers)
	}
}

func TestWriteAtomicCallbackPanicCleansUp(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "out.txt")

	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic to propagate")
		}
		if _, err := os.Stat(target); !os.IsNotExist(err) {
			t.Errorf("target should not exist after panic: stat err = %v", err)
		}
		if leftovers := scanTempLeftovers(t, dir); len(leftovers) != 0 {
			t.Errorf("leftover temp files after panic: %v", leftovers)
		}
	}()
	_ = writeAtomic(target, func(_ io.Writer) error {
		panic("boom")
	})
}

func TestWriteAtomicEmptyPathRejected(t *testing.T) {
	if err := writeAtomic("", func(_ io.Writer) error { return nil }); err == nil {
		t.Fatal("writeAtomic accepted empty path")
	}
}

func TestAtomicWriteCloserCommit(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "blob.bin")
	wc, err := newAtomicWriteCloser(target)
	if err != nil {
		t.Fatalf("newAtomicWriteCloser: %v", err)
	}
	if _, err := wc.Write([]byte("payload")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := wc.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read target: %v", err)
	}
	if string(got) != "payload" {
		t.Errorf("file contents = %q, want %q", got, "payload")
	}
	// Second Close is a no-op.
	if err := wc.Close(); err != nil {
		t.Errorf("second Close: %v", err)
	}
	// Write after Close errors.
	if _, err := wc.Write([]byte("nope")); err == nil {
		t.Errorf("write after Close should error")
	}
	if leftovers := scanTempLeftovers(t, dir); len(leftovers) != 0 {
		t.Errorf("leftover temp files: %v", leftovers)
	}
}

func TestAtomicWriteCloserAbortLeavesTargetUntouched(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "blob.bin")
	if err := os.WriteFile(target, []byte("original"), 0o600); err != nil {
		t.Fatalf("seed target: %v", err)
	}
	wc, err := newAtomicWriteCloser(target)
	if err != nil {
		t.Fatalf("newAtomicWriteCloser: %v", err)
	}
	if _, err := wc.Write([]byte("partial")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	wc.Abort()
	// Abort is idempotent.
	wc.Abort()

	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read target: %v", err)
	}
	if string(got) != "original" {
		t.Errorf("target overwritten despite Abort: %q", got)
	}
	if leftovers := scanTempLeftovers(t, dir); len(leftovers) != 0 {
		t.Errorf("leftover temp files after Abort: %v", leftovers)
	}
}

func TestAtomicWriteCloserEmptyPathRejected(t *testing.T) {
	if _, err := newAtomicWriteCloser(""); err == nil {
		t.Fatal("newAtomicWriteCloser accepted empty path")
	}
}

// TestAtomicWriteCloserCloseAfterCommitNoop guards against double-commit by
// invoking Close twice on a successful writer.
func TestAtomicWriteCloserCloseAfterCommitNoop(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "blob.bin")
	wc, err := newAtomicWriteCloser(target)
	if err != nil {
		t.Fatalf("newAtomicWriteCloser: %v", err)
	}
	if _, err := wc.Write([]byte("done")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := wc.Close(); err != nil {
		t.Fatalf("first Close: %v", err)
	}
	// After commit, Abort must be a no-op and target must remain.
	wc.Abort()
	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read target: %v", err)
	}
	if string(got) != "done" {
		t.Errorf("target = %q, want %q", got, "done")
	}
}

// TestNewAtomicWriteCloserCreatesParentDir asserts that the helper creates a
// missing parent directory rather than failing.
func TestNewAtomicWriteCloserCreatesParentDir(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "deeper", "nested", "blob.bin")
	wc, err := newAtomicWriteCloser(target)
	if err != nil {
		t.Fatalf("newAtomicWriteCloser: %v", err)
	}
	if _, err := wc.Write([]byte("ok")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := wc.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := os.Stat(target); err != nil {
		t.Errorf("target missing: %v", err)
	}
}

// TestNewAtomicWriteCloserRejectsNonDirParent reproduces the failure when the
// would-be parent path already exists as a regular file.
func TestNewAtomicWriteCloserRejectsNonDirParent(t *testing.T) {
	root := t.TempDir()
	parent := filepath.Join(root, "blocked")
	if err := os.WriteFile(parent, []byte("x"), 0o600); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	if _, err := newAtomicWriteCloser(filepath.Join(parent, "blob.bin")); err == nil {
		t.Fatal("newAtomicWriteCloser accepted non-dir parent")
	}
}

// TestAtomicWriteCloserCloseFailsAfterTmpClosed triggers the Sync failure
// branch by closing the underlying *os.File before invoking Close on the
// writer.
func TestAtomicWriteCloserCloseFailsAfterTmpClosed(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "blob.bin")
	wc, err := newAtomicWriteCloser(target)
	if err != nil {
		t.Fatalf("newAtomicWriteCloser: %v", err)
	}
	tmpName := wc.tmpName
	if err := wc.tmp.Close(); err != nil {
		t.Fatalf("close raw fd: %v", err)
	}
	if err := wc.Close(); err == nil {
		t.Fatal("Close should fail after underlying fd is closed")
	}
	if _, err := os.Stat(tmpName); !os.IsNotExist(err) {
		t.Errorf("temp file should be cleaned up: stat err = %v", err)
	}
}

// TestAtomicWriteCloserCloseFailsWhenTempVanishes triggers Close's chmod
// failure branch by removing the temp file from underneath the writer.
func TestAtomicWriteCloserCloseFailsWhenTempVanishes(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "blob.bin")
	wc, err := newAtomicWriteCloser(target)
	if err != nil {
		t.Fatalf("newAtomicWriteCloser: %v", err)
	}
	if _, err := wc.Write([]byte("data")); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := os.Remove(wc.tmpName); err != nil {
		t.Fatalf("remove temp: %v", err)
	}
	if err := wc.Close(); err == nil {
		t.Fatal("Close should fail when temp file vanished")
	}
	// Subsequent Close returns the cached error (covers the early-return branch).
	if err := wc.Close(); err == nil {
		t.Fatal("second Close should still report the cached error")
	}
}

// TestWriteAtomicRejectsNonDirParent covers the same branch on writeAtomic.
func TestWriteAtomicRejectsNonDirParent(t *testing.T) {
	root := t.TempDir()
	parent := filepath.Join(root, "blocked")
	if err := os.WriteFile(parent, []byte("x"), 0o600); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	target := filepath.Join(parent, "out.txt")
	if err := writeAtomic(target, func(w io.Writer) error { _, _ = w.Write([]byte("x")); return nil }); err == nil {
		t.Fatal("writeAtomic accepted non-dir parent")
	}
}
