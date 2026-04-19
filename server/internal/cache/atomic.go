package cache

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// dirPerm is the permission bitmask used for every directory created by the
// cache package. 0o700 keeps cached sources and artifacts readable only by the
// owning user (NFR-13).
const dirPerm os.FileMode = 0o700

// filePerm is the final permission for atomically renamed files. The temp
// file is created with the more restrictive default of os.CreateTemp (0o600)
// and explicitly chmod'ed before rename so the result is deterministic across
// umasks.
const filePerm os.FileMode = 0o600

// writeAtomic invokes write against a temporary file in the same directory as
// path and, on success, renames it over path. If write returns an error, or
// if the rename fails, the temporary file is removed. Renaming inside the
// same directory is atomic on POSIX file systems (ADR-10).
//
// The parent directory is created with 0o700 if it does not yet exist.
func writeAtomic(path string, write func(io.Writer) error) (retErr error) {
	if path == "" {
		return errors.New("cache: writeAtomic called with empty path")
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, dirPerm); err != nil {
		return fmt.Errorf("cache: ensure dir %q: %w", dir, err)
	}

	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return fmt.Errorf("cache: create temp in %q: %w", dir, err)
	}
	tmpName := tmp.Name()

	// Track whether the rename succeeded so cleanup can decide what to do.
	committed := false
	defer func() {
		if committed {
			return
		}
		// Best-effort cleanup; the original error from write/rename takes
		// precedence over Remove failures.
		_ = os.Remove(tmpName)
	}()

	// Recover any panic from the user-provided callback so the temp file is
	// still cleaned up. The panic is re-raised after deferred cleanup runs.
	func() {
		defer func() {
			if r := recover(); r != nil {
				_ = tmp.Close()
				panic(r)
			}
		}()
		if err = write(tmp); err != nil {
			return
		}
		err = tmp.Sync()
	}()
	if err != nil {
		_ = tmp.Close()
		return fmt.Errorf("cache: write temp %q: %w", tmpName, err)
	}
	if err = tmp.Close(); err != nil {
		return fmt.Errorf("cache: close temp %q: %w", tmpName, err)
	}
	if err = os.Chmod(tmpName, filePerm); err != nil {
		return fmt.Errorf("cache: chmod temp %q: %w", tmpName, err)
	}
	if err = os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("cache: rename %q -> %q: %w", tmpName, path, err)
	}
	committed = true
	return nil
}

// atomicWriteCloser is the io.WriteCloser returned by Manager.WriteParsedBlob.
// It buffers writes into a sibling temp file and renames it over the target
// on Close. Calling Close more than once is safe; subsequent calls return
// the result of the first.
type atomicWriteCloser struct {
	tmp     *os.File
	tmpName string
	target  string
	closed  bool
	err     error
}

func newAtomicWriteCloser(target string) (*atomicWriteCloser, error) {
	if target == "" {
		return nil, errors.New("cache: empty target path")
	}
	dir := filepath.Dir(target)
	if err := os.MkdirAll(dir, dirPerm); err != nil {
		return nil, fmt.Errorf("cache: ensure dir %q: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return nil, fmt.Errorf("cache: create temp in %q: %w", dir, err)
	}
	return &atomicWriteCloser{tmp: tmp, tmpName: tmp.Name(), target: target}, nil
}

// Write implements io.Writer.
func (a *atomicWriteCloser) Write(p []byte) (int, error) {
	if a.closed {
		return 0, fmt.Errorf("cache: write to closed atomic writer for %q", a.target)
	}
	return a.tmp.Write(p)
}

// Close finalises the write by syncing, chmod-ing and renaming the temp file.
// On error the temp file is removed and the target is left untouched.
func (a *atomicWriteCloser) Close() error {
	if a.closed {
		return a.err
	}
	a.closed = true

	if err := a.tmp.Sync(); err != nil {
		a.err = fmt.Errorf("cache: sync temp %q: %w", a.tmpName, err)
		_ = a.tmp.Close()
		_ = os.Remove(a.tmpName)
		return a.err
	}
	if err := a.tmp.Close(); err != nil {
		a.err = fmt.Errorf("cache: close temp %q: %w", a.tmpName, err)
		_ = os.Remove(a.tmpName)
		return a.err
	}
	if err := os.Chmod(a.tmpName, filePerm); err != nil {
		a.err = fmt.Errorf("cache: chmod temp %q: %w", a.tmpName, err)
		_ = os.Remove(a.tmpName)
		return a.err
	}
	if err := os.Rename(a.tmpName, a.target); err != nil {
		a.err = fmt.Errorf("cache: rename %q -> %q: %w", a.tmpName, a.target, err)
		_ = os.Remove(a.tmpName)
		return a.err
	}
	return nil
}

// Abort discards the temporary file without renaming it over the target. It
// is intended for callers that want to bail out of a partial write (for
// example after a producer goroutine fails). It is safe to call after Close;
// in that case it is a no-op.
func (a *atomicWriteCloser) Abort() {
	if a.closed {
		return
	}
	a.closed = true
	_ = a.tmp.Close()
	_ = os.Remove(a.tmpName)
	a.err = errors.New("cache: atomic write aborted")
}
