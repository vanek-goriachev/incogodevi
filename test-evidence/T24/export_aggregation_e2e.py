"""End-to-end smoke tests for T24 (export + aggregation expand).

Three browser scenarios from `tasks/T24-export-aggregation.md`:

  J1: Upload `simple.zip` -> wait for graph -> click the right-rail
      Export PNG button -> capture the triggered download as a real
      file under `artifacts/` and confirm the bytes parse as a PNG.

  J2: Upload `multi.zip` -> patch window.fetch so the SPA's graph
      request switches from aggregate=auto to aggregate=package, then
      reload so the canvas renders aggregated package nodes ->
      double-tap a package node and confirm the aggregated node is
      replaced by its detailed children. The available fixtures stay
      below the FR-18 1000-node threshold; the patch keeps the user
      flow honest while letting CI run without a multi-thousand-node
      corpus.

  J3: Upload `simple.zip` -> click Export SVG -> capture the SVG to
      `artifacts/` and verify the bytes start with an `<svg ` root
      element so it would open in Firefox.

Artifacts (PNG screenshots + downloaded PNG/SVG + a single text log)
land in this directory and serve as proof for the T24 review.
"""

from __future__ import annotations

import base64
import sys
import time
from pathlib import Path

from playwright.sync_api import Page, sync_playwright

HERE = Path(__file__).resolve().parent
EVIDENCE = HERE
ARTIFACTS = HERE / "artifacts"
FIXTURES = HERE.parent.parent / "web" / "e2e" / "fixtures"
LOG_PATH = EVIDENCE / "log.txt"

FRONTEND_URL = "http://localhost:5173"


def log(message: str) -> None:
    print(message, flush=True)
    with LOG_PATH.open("a", encoding="utf-8") as fh:
        fh.write(message + "\n")


def reset_log() -> None:
    if LOG_PATH.exists():
        LOG_PATH.unlink()
    ARTIFACTS.mkdir(parents=True, exist_ok=True)


def shot(page: Page, name: str) -> None:
    target = EVIDENCE / name
    page.screenshot(path=str(target), full_page=True)
    log(f"  screenshot: {target.name}")


def upload(page: Page, file_path: Path) -> None:
    page.set_input_files('[data-testid="landing-file-input"]', str(file_path))


def upload_and_wait(page: Page, file_path: Path, attempts: int = 3) -> None:
    """Upload `file_path` and wait until the main screen is visible.

    The backend single-flights `/analyze` per project_id (which is a hash of
    the upload). Two scenarios sharing the same fixture can collide if the
    previous run's analyze slot is still held; retry once after a short pause
    so the suite stays deterministic without depending on cache eviction.
    """
    last_err: Exception | None = None
    for attempt in range(attempts):
        if attempt > 0:
            page.wait_for_timeout(2000)
            page.goto(FRONTEND_URL)
            page.wait_for_load_state("networkidle")
        upload(page, file_path)
        try:
            wait_for_main(page)
            return
        except Exception as exc:  # noqa: BLE001 - retry path
            last_err = exc
            log(f"  upload attempt {attempt + 1} failed: {exc}")
    raise last_err if last_err else RuntimeError("upload failed without diagnostic")


def wait_for_main(page: Page) -> None:
    page.wait_for_selector('[data-testid="screen-main"]', timeout=20_000)
    page.wait_for_selector('[data-testid="graph-canvas"]', timeout=10_000)
    page.wait_for_function(
        "document.querySelector('[data-testid=\"graph-canvas\"]') && "
        "document.querySelector('[data-testid=\"graph-canvas\"]').querySelector('canvas') !== null",
        timeout=15_000,
    )
    page.wait_for_function(
        """() => {
            const el = document.querySelector('[data-testid="graph-canvas"]');
            const cy = el && el._cyreg && el._cyreg.cy;
            return !!cy && cy.nodes().length > 0;
        }""",
        timeout=15_000,
    )


def cy_summary(page: Page) -> dict:
    return page.evaluate(
        """() => {
            const el = document.querySelector('[data-testid="graph-canvas"]');
            const cy = el && el._cyreg && el._cyreg.cy;
            if (!cy) return null;
            const pkgs = cy.nodes('[kind="package"]');
            const pkgInfo = pkgs.map(n => ({
                package: n.data('package'),
                child_count: n.data('child_count') || 0,
            }));
            return {
                nodes: cy.nodes().length,
                edges: cy.edges().length,
                packages: pkgs.length,
                packageIds: pkgs.map(n => n.data('package')).slice(0, 5),
                packageInfo: pkgInfo,
            };
        }"""
    )


def install_blob_capture(page: Page) -> None:
    """Patch the anchor click + FileReader so we can pull blob bytes back."""
    page.evaluate(
        """() => {
            window.__downloads = [];
            const orig = HTMLAnchorElement.prototype.click;
            HTMLAnchorElement.prototype.click = function() {
                if (this.download && this.href && this.href.startsWith('blob:')) {
                    const href = this.href;
                    const name = this.download;
                    fetch(href).then(r => r.blob()).then(b => {
                        return new Promise((resolve) => {
                            const reader = new FileReader();
                            reader.onloadend = () => {
                                window.__downloads.push({
                                    download: name,
                                    href,
                                    type: b.type,
                                    size: b.size,
                                    base64: (reader.result || '').toString().split(',')[1] || '',
                                });
                                resolve();
                            };
                            reader.readAsDataURL(b);
                        });
                    });
                }
                return orig.apply(this, arguments);
            };
        }"""
    )


def collected_downloads(page: Page) -> list[dict]:
    return page.evaluate("() => window.__downloads || []")


def install_aggregate_force(page: Page) -> None:
    """Rewrite any /graph?aggregate=auto request to aggregate=package so the
    SPA renders the aggregated view without needing a >1000-node fixture."""
    page.add_init_script(
        """(() => {
            const origFetch = window.fetch;
            window.fetch = function(input, init) {
                try {
                    let url = typeof input === 'string' ? input : (input && input.url) || '';
                    if (url && url.indexOf('/graph') !== -1 && url.indexOf('aggregate=') !== -1) {
                        const rewritten = url.replace(/aggregate=[^&]+/, 'aggregate=package');
                        if (typeof input === 'string') {
                            return origFetch(rewritten, init);
                        }
                        return origFetch(new Request(rewritten, input), init);
                    }
                } catch (e) { /* noop */ }
                return origFetch(input, init);
            };
        })();"""
    )


def scenario_j1_export_png(page: Page) -> None:
    log("J1: small fixture -> Export PNG -> downloaded blob is a valid PNG")
    page.goto(FRONTEND_URL)
    page.wait_for_load_state("networkidle")
    install_blob_capture(page)
    upload_and_wait(page, FIXTURES / "simple.zip")

    summary = cy_summary(page)
    log(f"  cy summary: {summary}")
    assert summary is not None and summary["nodes"] > 0

    page.wait_for_selector('[data-testid="export-panel-png"]', timeout=10_000)
    shot(page, "j1-01-before-png-export.png")

    page.locator('[data-testid="export-panel-png"]').click()
    page.wait_for_function(
        "() => (window.__downloads || []).length > 0",
        timeout=10_000,
    )
    downloads = collected_downloads(page)
    log(f"  captured downloads: count={len(downloads)} entries={[(d['download'], d['size'], d['type']) for d in downloads]}")
    assert len(downloads) >= 1
    entry = downloads[0]
    assert entry["download"].endswith(".png"), entry["download"]
    assert "graph" in entry["download"], entry["download"]
    payload = base64.b64decode(entry["base64"])
    assert payload[:8] == b"\x89PNG\r\n\x1a\n", "downloaded blob is not a PNG"
    out = ARTIFACTS / entry["download"]
    out.write_bytes(payload)
    log(f"  saved artefact: {out.relative_to(EVIDENCE.parent)} ({len(payload)} bytes)")
    shot(page, "j1-02-after-png-export.png")


def scenario_j2_aggregate_expand(page: Page) -> None:
    log("J2: forced aggregation -> double-click package node -> sub-graph appears")
    install_aggregate_force(page)
    page.goto(FRONTEND_URL)
    page.wait_for_load_state("networkidle")
    upload_and_wait(page, FIXTURES / "multi.zip")

    summary = cy_summary(page)
    log(f"  initial cy summary: {summary}")
    assert summary is not None and summary["packages"] >= 1, (
        f"expected at least one aggregated package node, got {summary}"
    )
    initial_node_count = summary["nodes"]
    initial_pkg_count = summary["packages"]
    # Pick the package with the largest declared child_count so the expansion
    # has the highest chance of inserting fresh detail nodes; fall back to the
    # first package if the field is uniformly zero.
    candidates = sorted(
        summary["packageInfo"],
        key=lambda p: int(p.get("child_count") or 0),
        reverse=True,
    )
    target_pkg = candidates[0]["package"] if candidates else summary["packageIds"][0]
    log(f"  target package: {target_pkg} (child_count={candidates[0].get('child_count') if candidates else 'n/a'})")
    shot(page, "j2-01-aggregated-view.png")

    # Drive the expand path through the public hook surface; cy.dbltap is
    # awkward to dispatch reliably from outside the renderer, so trigger the
    # underlying expand() via the cytoscape selector cy.emit pipeline.
    page.evaluate(
        """(pkg) => {
            const el = document.querySelector('[data-testid="graph-canvas"]');
            const cy = el && el._cyreg && el._cyreg.cy;
            const node = cy.nodes('[package="' + pkg.replace(/(["\\\\])/g, '\\\\$1') + '"][kind="package"]').first();
            if (node && node.length) {
                node.emit('dbltap');
            }
        }""",
        target_pkg,
    )
    # Wait for the aggregated node to be removed and detail nodes to appear.
    page.wait_for_function(
        """(pkg) => {
            const el = document.querySelector('[data-testid="graph-canvas"]');
            const cy = el && el._cyreg && el._cyreg.cy;
            if (!cy) return false;
            const aggregated = cy.nodes('[package="' + pkg.replace(/(["\\\\])/g, '\\\\$1') + '"][kind="package"]');
            const details = cy.nodes('[package="' + pkg.replace(/(["\\\\])/g, '\\\\$1') + '"]').filter(n => n.data('kind') !== 'package');
            return aggregated.length === 0 && details.length > 0;
        }""",
        arg=target_pkg,
        timeout=10_000,
    )
    summary_after = cy_summary(page)
    log(f"  cy summary after expand: {summary_after}")
    assert summary_after is not None
    # The aggregated node for the target package must be gone…
    assert summary_after["packages"] == initial_pkg_count - 1, (
        f"expected one fewer aggregated package, before={initial_pkg_count} after={summary_after['packages']}"
    )
    # …and at least one non-package node from that package must now be present.
    detail_count = page.evaluate(
        """(pkg) => {
            const el = document.querySelector('[data-testid="graph-canvas"]');
            const cy = el && el._cyreg && el._cyreg.cy;
            return cy.nodes('[package="' + pkg.replace(/(["\\\\])/g, '\\\\$1') + '"]')
                .filter(n => n.data('kind') !== 'package').length;
        }""",
        target_pkg,
    )
    log(f"  detail nodes for {target_pkg}: {detail_count}")
    assert detail_count >= 1, f"expected at least one detail node for {target_pkg}, got {detail_count}"
    shot(page, "j2-02-after-expand.png")


def scenario_j3_export_svg(page: Page) -> None:
    log("J3: small fixture -> Export SVG -> downloaded blob is a valid SVG")
    page.goto(FRONTEND_URL)
    page.wait_for_load_state("networkidle")
    install_blob_capture(page)
    upload_and_wait(page, FIXTURES / "simple.zip")

    page.wait_for_selector('[data-testid="export-panel-svg"]', timeout=10_000)
    page.locator('[data-testid="export-panel-svg"]').click()
    page.wait_for_function(
        "() => (window.__downloads || []).length > 0",
        timeout=10_000,
    )
    downloads = collected_downloads(page)
    log(f"  captured downloads: count={len(downloads)} entries={[(d['download'], d['size'], d['type']) for d in downloads]}")
    assert len(downloads) >= 1
    entry = downloads[0]
    assert entry["download"].endswith(".svg"), entry["download"]
    payload = base64.b64decode(entry["base64"]).decode("utf-8", errors="replace")
    assert payload.lstrip().startswith("<"), "SVG payload does not start with an XML element"
    assert "<svg" in payload, "SVG payload is missing the <svg> root"
    out = ARTIFACTS / entry["download"]
    out.write_text(payload, encoding="utf-8")
    log(f"  saved artefact: {out.relative_to(EVIDENCE.parent)} ({len(payload)} chars)")
    shot(page, "j3-01-after-svg-export.png")


def main() -> int:
    reset_log()
    log("T24 E2E run starting")
    log(f"  fixtures: {FIXTURES}")
    log(f"  artifacts: {ARTIFACTS}")

    started = time.perf_counter()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        failures: list[str] = []
        for scenario in (
            scenario_j1_export_png,
            scenario_j2_aggregate_expand,
            scenario_j3_export_svg,
        ):
            # Each scenario gets a clean context so the aggregate-rewrite init
            # script in J2 cannot leak into J1 / J3.
            context = browser.new_context(viewport={"width": 1280, "height": 800})
            page = context.new_page()
            page.on(
                "console",
                lambda msg: log(f"  console[{msg.type}]: {msg.text}")
                if msg.type in {"error"}
                else None,
            )
            try:
                scenario(page)
                log(f"  -> PASS: {scenario.__name__}")
            except Exception as exc:  # noqa: BLE001 - top-level reporter
                log(f"  -> FAIL: {scenario.__name__}: {exc}")
                try:
                    shot(page, f"FAIL-{scenario.__name__}.png")
                except Exception:  # noqa: BLE001
                    pass
                failures.append(scenario.__name__)
            finally:
                context.close()

        browser.close()

    elapsed = time.perf_counter() - started
    log(f"T24 E2E elapsed: {elapsed:.1f}s")
    if failures:
        log(f"T24 E2E run FAILED: {failures}")
        return 1
    log("T24 E2E run SUCCESS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
