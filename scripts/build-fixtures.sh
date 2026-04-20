#!/usr/bin/env bash
# Build E2E fixture archives declared in e2e/fixtures/manifest.json.
#
# Usage:
#   scripts/build-fixtures.sh           # build only what is missing in cache
#   scripts/build-fixtures.sh --force   # rebuild everything
#
# Output: zip files in e2e/fixtures/.cache/<name>.zip. The cache directory is
# git-ignored. The script is idempotent and safe to run multiple times.
#
# For "git" fixtures the upstream repository is shallow-cloned at the pinned
# SHA. If the host has no internet access the script logs a warning and skips
# that fixture so the local fixtures (kind=local) still work.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MANIFEST="${ROOT}/e2e/fixtures/manifest.json"
CACHE_DIR="${ROOT}/e2e/fixtures/.cache"
FORCE=0

for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
        -h|--help)
            sed -n '2,16p' "${BASH_SOURCE[0]}"
            exit 0
            ;;
        *)
            echo "unknown argument: $arg" >&2
            exit 2
            ;;
    esac
done

if [ ! -f "$MANIFEST" ]; then
    echo "manifest not found: $MANIFEST" >&2
    exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
    echo "jq is required to parse the manifest" >&2
    exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
    echo "zip is required to build fixture archives" >&2
    exit 1
fi

mkdir -p "$CACHE_DIR"

count=$(jq '.fixtures | length' "$MANIFEST")
i=0
while [ "$i" -lt "$count" ]; do
    name=$(jq -r ".fixtures[$i].name" "$MANIFEST")
    kind=$(jq -r ".fixtures[$i].kind" "$MANIFEST")
    out="${CACHE_DIR}/${name}.zip"
    zip_root=$(jq -r ".fixtures[$i].zip_root // .fixtures[$i].name" "$MANIFEST")

    if [ "$FORCE" -eq 0 ] && [ -f "$out" ]; then
        echo "[fixtures] skip ${name} (cached: $out)"
        i=$((i + 1))
        continue
    fi

    # Always start from a clean output file so `zip -r` does not append on
    # top of a previous build (which would interleave stale and fresh entries).
    rm -f "$out"

    case "$kind" in
        local)
            src_rel=$(jq -r ".fixtures[$i].source_dir" "$MANIFEST")
            src="${ROOT}/${src_rel}"
            if [ ! -d "$src" ]; then
                echo "[fixtures] local source missing: $src" >&2
                exit 1
            fi
            echo "[fixtures] build ${name} from ${src_rel}"
            tmp=$(mktemp -d)
            trap 'rm -rf "$tmp"' EXIT
            # Pack files at the archive root rather than under a single
            # leading directory so the analyser's `findGoMod` (which scans
            # root + first subdirectory) reliably picks up `go.mod`.
            cp -R "$src/." "$tmp/"
            (cd "$tmp" && zip -qr "$out" .)
            rm -rf "$tmp"
            trap - EXIT
            ;;
        git)
            url=$(jq -r ".fixtures[$i].upstream_url" "$MANIFEST")
            sha=$(jq -r ".fixtures[$i].sha" "$MANIFEST")
            echo "[fixtures] build ${name} from ${url}@${sha}"
            tmp=$(mktemp -d)
            trap 'rm -rf "$tmp"' EXIT
            ok=1
            if ! git clone --quiet "$url" "${tmp}/${zip_root}" 2>/dev/null; then
                echo "[fixtures] WARN cannot clone ${url}; skipping ${name}" >&2
                ok=0
            elif ! (cd "${tmp}/${zip_root}" && git checkout --quiet "$sha" 2>/dev/null); then
                echo "[fixtures] WARN cannot checkout ${sha} in ${url}; skipping ${name}" >&2
                ok=0
            fi
            if [ "$ok" -eq 1 ]; then
                rm -rf "${tmp}/${zip_root}/.git"
                # Pack at the archive root (no leading directory) so the parser's
                # `packages.Load("./...")` runs in the same directory that holds
                # `go.mod`. With a leading directory the analyser reports
                # `import_error: directory prefix . does not contain main module`
                # and produces a single placeholder node.
                (cd "${tmp}/${zip_root}" && zip -qr "$out" .)
                echo "[fixtures] wrote $out ($(du -h "$out" | cut -f1))"
            fi
            rm -rf "$tmp"
            trap - EXIT
            i=$((i + 1))
            continue
            ;;
        *)
            echo "[fixtures] unknown kind '$kind' for $name" >&2
            exit 1
            ;;
    esac

    echo "[fixtures] wrote $out ($(du -h "$out" | cut -f1))"
    i=$((i + 1))
done

echo "[fixtures] done"
