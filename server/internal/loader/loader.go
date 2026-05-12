package loader

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/mod/modfile"

	"github.com/vanek-goriachev/incogodevi/server/internal/cache"
	"github.com/vanek-goriachev/incogodevi/server/internal/domain"
)

// Default budget values. They mirror NFR-04 and ADR-08 and are intentionally
// shared with the HTTP layer (T14) which installs a matching MaxBytesReader.
const (
	DefaultMaxArchiveBytes  int64 = 50 * 1024 * 1024
	DefaultMaxFiles               = 10_000
	DefaultMaxUnpackedBytes int64 = 500 * 1024 * 1024
)

// goModFileName is the on-disk name we accept as the project's module file.
// Matching is case-sensitive on every supported platform (linux/darwin); the
// loader does not try to resolve case-insensitive duplicates.
const goModFileName = "go.mod"

// dirPerm and filePerm are the permission bits applied to extracted entries.
// They match cache.dirPerm/filePerm to satisfy NFR-13 across the whole
// project tree.
const (
	dirPerm  os.FileMode = 0o700
	filePerm os.FileMode = 0o600
)

// Config captures the per-upload safety budget. Zero values fall back
// to the Default* constants so callers can construct a Loader with an empty
// Config{}.
type Config struct {
	// MaxArchiveBytes caps the raw, compressed upload size before the loader
	// reads a single byte (NFR-14). Equal to the HTTP-layer
	// http.MaxBytesReader value.
	MaxArchiveBytes int64

	// MaxFiles caps the number of zip entries (regular files plus
	// directories) we are willing to materialise.
	MaxFiles int

	// MaxUnpackedBytes caps the cumulative UncompressedSize64 reported in
	// the central directory and is rechecked while writing.
	MaxUnpackedBytes int64
}

// withDefaults returns a copy where unset fields are populated with the
// package defaults.
func (c Config) withDefaults() Config {
	if c.MaxArchiveBytes <= 0 {
		c.MaxArchiveBytes = DefaultMaxArchiveBytes
	}
	if c.MaxFiles <= 0 {
		c.MaxFiles = DefaultMaxFiles
	}
	if c.MaxUnpackedBytes <= 0 {
		c.MaxUnpackedBytes = DefaultMaxUnpackedBytes
	}
	return c
}

// Loader extracts an uploaded ZIP into the cache.Manager-owned sources
// directory and persists the resulting ProjectMeta. Loaders are safe for
// concurrent use: each Load call allocates its own temporary spool and never
// touches the receiver beyond reading the immutable cache/cfg/logger fields.
type Loader struct {
	cache  cache.Manager
	cfg    Config
	logger *slog.Logger
}

// New constructs a Loader. Manager must be non-nil; logger may be nil and
// will fall back to slog.Default.
func New(manager cache.Manager, cfg Config, logger *slog.Logger) *Loader {
	if manager == nil {
		panic("loader: cache manager must not be nil")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &Loader{
		cache:  manager,
		cfg:    cfg.withDefaults(),
		logger: logger,
	}
}

// Load consumes r as a ZIP archive and produces a ready-to-analyse project.
//
// Behavioural contract:
//
//   - If declaredSize is non-negative and exceeds MaxArchiveBytes, the call
//     returns ErrArchiveTooLarge before reading r. The loader additionally
//     enforces the same limit while spooling, so callers may safely pass -1
//     when the size is unknown (e.g. chunked uploads).
//   - r is fully consumed and spooled to a temporary file so the
//     archive/zip reader can use random access without buffering 50 MiB in
//     memory (NFR-07). The temp file is removed in defer.
//   - On any error after cache.Manager.NewProject succeeds, the per-project
//     sources/cache directories are removed so the caller never observes a
//     half-initialised project.
//   - displayName is used verbatim when non-empty; otherwise the loader
//     falls back to the module name parsed from go.mod.
func (l *Loader) Load(ctx context.Context, r io.Reader, declaredSize int64, displayName string) (*cache.ProjectMeta, error) {
	if r == nil {
		return nil, errors.New("loader: reader is nil")
	}
	if declaredSize > l.cfg.MaxArchiveBytes {
		return nil, fmt.Errorf("loader: declared size %d exceeds limit %d: %w",
			declaredSize, l.cfg.MaxArchiveBytes, domain.ErrArchiveTooLarge)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}

	spool, spoolSize, err := l.spool(r)
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = spool.Close()
		_ = os.Remove(spool.Name())
	}()

	zr, err := zip.NewReader(spool, spoolSize)
	if err != nil {
		return nil, fmt.Errorf("loader: open zip: %w", err)
	}

	if err := l.preflight(zr); err != nil {
		return nil, err
	}

	// Reserve the project on the cache side so the directory layout exists
	// before extraction begins. Size and file count are corrected after a
	// successful unpack (zr.File contains directories too — the final count
	// is the number of regular files actually written).
	project, err := l.cache.NewProject(displayName, spoolSize, len(zr.File))
	if err != nil {
		return nil, fmt.Errorf("loader: reserve project: %w", err)
	}

	committed := false
	defer func() {
		if committed {
			return
		}
		if delErr := l.cache.DeleteProject(project.Meta.ID); delErr != nil {
			l.logger.Warn("loader: rollback failed",
				slog.String("project_id", string(project.Meta.ID)),
				slog.String("error", delErr.Error()))
		}
	}()

	written, err := l.extract(ctx, zr, project.SourcesDir)
	if err != nil {
		return nil, err
	}

	if err := flattenSingleWrapperDir(project.SourcesDir); err != nil {
		return nil, err
	}

	moduleName, err := readModuleName(project.SourcesDir)
	if err != nil {
		return nil, err
	}

	finalName := strings.TrimSpace(displayName)
	if finalName == "" {
		finalName = moduleName
	}

	updated := project.Meta
	updated.Name = finalName
	updated.SizeBytes = spoolSize
	updated.FileCount = written
	if err := l.cache.WriteMeta(project.Meta.ID, &updated); err != nil {
		return nil, fmt.Errorf("loader: persist meta: %w", err)
	}
	committed = true
	return &updated, nil
}

// spool copies r into a freshly created temp file while enforcing
// MaxArchiveBytes. The returned *os.File is positioned at offset 0 so
// callers may pass it directly to archive/zip. Ownership transfers to the
// caller, who must Close + Remove it.
func (l *Loader) spool(r io.Reader) (*os.File, int64, error) {
	tmp, err := os.CreateTemp("", "go-viz-upload-*.zip")
	if err != nil {
		return nil, 0, fmt.Errorf("loader: create spool: %w", err)
	}

	// LimitReader reads at most MaxArchiveBytes+1 — one extra byte lets us
	// detect overruns without having to trust Content-Length.
	limited := io.LimitReader(r, l.cfg.MaxArchiveBytes+1)
	written, err := io.Copy(tmp, limited)
	if err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return nil, 0, fmt.Errorf("loader: spool body: %w", err)
	}
	if written > l.cfg.MaxArchiveBytes {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return nil, 0, fmt.Errorf("loader: archive size %d exceeds limit %d: %w",
			written, l.cfg.MaxArchiveBytes, domain.ErrArchiveTooLarge)
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return nil, 0, fmt.Errorf("loader: rewind spool: %w", err)
	}
	return tmp, written, nil
}

// preflight inspects the central directory only. It rejects archives that
// exceed the entry count or that declare more uncompressed bytes than the
// configured budget; it never opens an entry for reading. NFR-14 requires
// these checks to happen before any I/O write.
func (l *Loader) preflight(zr *zip.Reader) error {
	if len(zr.File) > l.cfg.MaxFiles {
		return fmt.Errorf("loader: %d entries exceed limit %d: %w",
			len(zr.File), l.cfg.MaxFiles, domain.ErrFileCountExceeded)
	}

	var declared uint64
	limit := uint64(l.cfg.MaxUnpackedBytes)
	for _, f := range zr.File {
		if f.UncompressedSize64 > limit {
			return fmt.Errorf("loader: entry %q declares %d bytes, exceeds limit %d: %w",
				f.Name, f.UncompressedSize64, limit, domain.ErrUnpackedSizeExceeded)
		}
		// Cumulative check uses saturating addition — overflow alone is
		// already a violation.
		next, overflow := addOverflow(declared, f.UncompressedSize64)
		if overflow || next > limit {
			return fmt.Errorf("loader: cumulative declared size %d exceeds limit %d: %w",
				next, limit, domain.ErrUnpackedSizeExceeded)
		}
		declared = next
	}
	return nil
}

// extract walks the archive entries in order, materialising files with
// 0o600 permissions and directories with 0o700. Per-entry write size and the
// running cumulative total are double-checked against MaxUnpackedBytes so
// that any mismatch between the declared and actual sizes (a classic
// zip-bomb trick) is caught mid-flight.
//
// Returns the number of regular files written. Directories and symlinks are
// not counted; symlinks are rejected outright (NFR-13).
func (l *Loader) extract(ctx context.Context, zr *zip.Reader, root string) (int, error) {
	var (
		written  int
		unpacked int64
	)
	for _, f := range zr.File {
		if err := ctx.Err(); err != nil {
			return 0, err
		}

		rel, err := sanitisePath(f.Name)
		if err != nil {
			return 0, err
		}
		if rel == "" {
			// Skip empty/"." entries — some archivers emit them as the
			// archive's own root.
			continue
		}

		dst := filepath.Join(root, rel)

		mode := f.Mode()
		if mode&os.ModeSymlink != 0 {
			return 0, fmt.Errorf("loader: symlink entry %q rejected: %w", f.Name, domain.ErrZipSlip)
		}

		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(dst, dirPerm); err != nil {
				return 0, fmt.Errorf("loader: mkdir %q: %w", dst, err)
			}
			continue
		}

		if !mode.IsRegular() {
			return 0, fmt.Errorf("loader: irregular entry %q (mode %v) rejected: %w",
				f.Name, mode, domain.ErrZipSlip)
		}

		if err := os.MkdirAll(filepath.Dir(dst), dirPerm); err != nil {
			return 0, fmt.Errorf("loader: mkdir parent of %q: %w", dst, err)
		}

		n, err := writeEntry(ctx, f, dst, l.cfg.MaxUnpackedBytes-unpacked)
		if err != nil {
			return 0, err
		}
		unpacked += n
		if unpacked > l.cfg.MaxUnpackedBytes {
			return 0, fmt.Errorf("loader: unpacked size %d exceeds limit %d: %w",
				unpacked, l.cfg.MaxUnpackedBytes, domain.ErrUnpackedSizeExceeded)
		}
		written++
	}
	return written, nil
}

// writeEntry opens a single zip entry and copies it onto disk under dst,
// honouring ctx cancellation and a per-entry byte budget. The budget is the
// remaining uncompressed allowance (MaxUnpackedBytes minus what has already
// been written for previous entries).
func writeEntry(ctx context.Context, f *zip.File, dst string, remainingBudget int64) (int64, error) {
	src, err := f.Open()
	if err != nil {
		return 0, fmt.Errorf("loader: open entry %q: %w", f.Name, err)
	}
	defer func() { _ = src.Close() }()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, filePerm)
	if err != nil {
		return 0, fmt.Errorf("loader: create %q: %w", dst, err)
	}

	// CopyN with budget+1 lets us distinguish "exactly at the limit" from
	// "one byte over".
	n, copyErr := io.CopyN(out, &cancelReader{ctx: ctx, r: src}, remainingBudget+1)
	if copyErr != nil && !errors.Is(copyErr, io.EOF) {
		_ = out.Close()
		_ = os.Remove(dst)
		return 0, fmt.Errorf("loader: copy %q: %w", dst, copyErr)
	}
	if n > remainingBudget {
		_ = out.Close()
		_ = os.Remove(dst)
		return 0, fmt.Errorf("loader: entry %q exceeded remaining budget: %w",
			f.Name, domain.ErrUnpackedSizeExceeded)
	}
	if err := out.Close(); err != nil {
		_ = os.Remove(dst)
		return 0, fmt.Errorf("loader: close %q: %w", dst, err)
	}
	return n, nil
}

// cancelReader wraps an io.Reader so a cancelled context aborts the copy at
// the next Read boundary. zip entries are decompressed on the fly, so a
// single Read call here can take a non-trivial amount of CPU on hostile
// inputs; checking ctx.Err per Read keeps the cancel latency bounded by the
// underlying decompressor's chunk size.
type cancelReader struct {
	ctx context.Context
	r   io.Reader
}

func (c *cancelReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

// sanitisePath validates a single zip entry path and returns the cleaned
// slash-separated form converted to the OS-native separator. It rejects:
//
//   - absolute paths (POSIX or Windows)
//   - parent-directory escapes ("..", "../foo", "foo/../../bar")
//   - paths embedding a NUL byte
//   - drive-letter prefixes ("C:\\")
func sanitisePath(name string) (string, error) {
	if name == "" {
		return "", nil
	}
	if strings.ContainsRune(name, 0) {
		return "", fmt.Errorf("loader: NUL in entry path %q: %w", name, domain.ErrZipSlip)
	}
	if strings.Contains(name, "\\") {
		return "", fmt.Errorf("loader: backslash in entry path %q: %w", name, domain.ErrZipSlip)
	}
	if filepath.IsAbs(name) || strings.HasPrefix(name, "/") {
		return "", fmt.Errorf("loader: absolute entry path %q: %w", name, domain.ErrZipSlip)
	}
	// Detect Windows-style drive letters even on POSIX hosts where
	// filepath.IsAbs would not catch them.
	if len(name) >= 2 && name[1] == ':' {
		return "", fmt.Errorf("loader: drive-letter entry path %q: %w", name, domain.ErrZipSlip)
	}

	cleaned := filepath.ToSlash(filepath.Clean(name))
	if cleaned == "." {
		return "", nil
	}
	if cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", fmt.Errorf("loader: traversal in entry path %q: %w", name, domain.ErrZipSlip)
	}
	if filepath.IsAbs(cleaned) {
		return "", fmt.Errorf("loader: absolute cleaned path %q: %w", name, domain.ErrZipSlip)
	}
	return filepath.FromSlash(cleaned), nil
}

// readModuleName locates the first go.mod under root (root or first
// sub-directory) and parses its `module` directive. Returns
// ErrGoModMissing if no go.mod is found within those two levels.
func readModuleName(root string) (string, error) {
	candidate, err := findGoMod(root)
	if err != nil {
		return "", err
	}
	raw, err := os.ReadFile(candidate)
	if err != nil {
		return "", fmt.Errorf("loader: read %q: %w", candidate, err)
	}
	mf, err := modfile.ParseLax(candidate, raw, nil)
	if err != nil {
		return "", fmt.Errorf("loader: parse go.mod %q: %w", candidate, err)
	}
	if mf.Module == nil || strings.TrimSpace(mf.Module.Mod.Path) == "" {
		return "", fmt.Errorf("loader: empty module path in %q: %w", candidate, domain.ErrGoModMissing)
	}
	return mf.Module.Mod.Path, nil
}

// findGoMod returns the path to the go.mod that should describe the
// project. The contract documented in api-contract.md §1 says: the file
// lives either in the archive root or in the first sub-directory; the
// first match wins.
func findGoMod(root string) (string, error) {
	rootCandidate := filepath.Join(root, goModFileName)
	if info, err := os.Stat(rootCandidate); err == nil && !info.IsDir() {
		return rootCandidate, nil
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		return "", fmt.Errorf("loader: read sources dir %q: %w", root, err)
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		candidate := filepath.Join(root, entry.Name(), goModFileName)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate, nil
		}
	}
	return "", fmt.Errorf("loader: no go.mod under %q: %w", root, domain.ErrGoModMissing)
}

// flattenSingleWrapperDir promotes the contents of a single top-level wrapper
// directory to root when the archive layout is `wrapper/go.mod` plus
// everything else nested inside `wrapper/` (the typical result of
// `zip -r foo.zip foo/`). Without this step the parser receives SourcesDir as
// the working directory but `go list ./...` sees no module file and returns
// "directory prefix . does not contain main module".
//
// macOS Finder injects `__MACOSX/` and `.DS_Store` next to the actual payload;
// they are ignored when counting top-level entries and removed after a
// successful flatten so the final tree is clean.
//
// The flatten is intentionally conservative: it only fires when (a) exactly
// one significant top-level entry exists, (b) it is a directory, and (c) it
// contains a go.mod at its root. Any other shape — multi-module monorepos,
// archives without a wrapper, archives whose wrapper is just `cmd/` — is left
// untouched so the existing two-level findGoMod search still applies.
func flattenSingleWrapperDir(root string) error {
	entries, err := os.ReadDir(root)
	if err != nil {
		return fmt.Errorf("loader: read root for flatten: %w", err)
	}

	var only os.DirEntry
	for _, e := range entries {
		if isFinderCruft(e.Name()) {
			continue
		}
		if only != nil {
			return nil
		}
		only = e
	}
	if only == nil || !only.IsDir() {
		return nil
	}

	wrapper := filepath.Join(root, only.Name())
	if info, err := os.Stat(filepath.Join(wrapper, goModFileName)); err != nil || info.IsDir() {
		return nil
	}

	nested, err := os.ReadDir(wrapper)
	if err != nil {
		return fmt.Errorf("loader: read wrapper %q: %w", wrapper, err)
	}
	for _, e := range nested {
		from := filepath.Join(wrapper, e.Name())
		to := filepath.Join(root, e.Name())
		if _, err := os.Stat(to); err == nil {
			return nil
		}
		if err := os.Rename(from, to); err != nil {
			return fmt.Errorf("loader: promote %q: %w", from, err)
		}
	}
	if err := os.Remove(wrapper); err != nil {
		return fmt.Errorf("loader: remove wrapper %q: %w", wrapper, err)
	}
	_ = os.RemoveAll(filepath.Join(root, "__MACOSX"))
	_ = os.Remove(filepath.Join(root, ".DS_Store"))
	return nil
}

// isFinderCruft returns true for the cosmetic entries macOS Finder injects
// into archives — `__MACOSX/` (resource-fork sidecar) and `.DS_Store`.
func isFinderCruft(name string) bool {
	return name == "__MACOSX" || name == ".DS_Store"
}

// addOverflow returns a + b and reports whether the addition overflowed
// uint64. Used to keep the cumulative-size check sound on hostile inputs.
func addOverflow(a, b uint64) (uint64, bool) {
	sum := a + b
	return sum, sum < a
}
