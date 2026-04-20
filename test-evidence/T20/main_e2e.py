"""End-to-end smoke tests for T20 (Cytoscape integration).

Three browser scenarios from `tasks/T20-cytoscape-integration.md`:

  J1: Upload `simple.zip` -> Analyzing -> Main view, then verify the
      Cytoscape canvas is mounted, the project headline carries node /
      dead counts and the canvas exposes the application landmark.

  J2: From the rendered graph, exercise wheel zoom, drag a node and
      press `f` to fit. We assert the Cytoscape zoom level changed and
      that drag updated the persisted positions in localStorage.

  J3: Reload the page after positioning a node and confirm the position
      is restored from localStorage (FR-26 sanity).

Artifacts (PNG screenshots + a single text log) land in this directory
and serve as proof for the T20 review on the merge PR.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright

HERE = Path(__file__).resolve().parent
EVIDENCE = HERE
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


def shot(page: Page, name: str) -> None:
    target = EVIDENCE / name
    page.screenshot(path=str(target), full_page=True)
    log(f"  screenshot: {target.name}")


def upload(page: Page, file_path: Path) -> None:
    page.set_input_files('[data-testid="landing-file-input"]', str(file_path))


def wait_for_main(page: Page) -> None:
    page.wait_for_selector('[data-testid="screen-main"]', timeout=20_000)
    page.wait_for_selector('[data-testid="graph-canvas"]', timeout=10_000)
    # Cytoscape paints onto a child <canvas>. Wait for at least one to appear.
    page.wait_for_function(
        "document.querySelector('[data-testid=\"graph-canvas\"]') && "
        "document.querySelector('[data-testid=\"graph-canvas\"]').querySelector('canvas') !== null",
        timeout=10_000,
    )


def scenario_j1_render(page: Page) -> None:
    log("J1: upload simple.zip and verify Cytoscape canvas mounts")
    page.goto(FRONTEND_URL)
    page.wait_for_load_state("networkidle")
    upload(page, FIXTURES / "simple.zip")

    page.wait_for_selector('[data-testid="screen-analyzing"]', timeout=15_000)
    wait_for_main(page)
    shot(page, "j1-01-main-graph.png")

    headline = page.locator('[data-testid="main-project-name"]').inner_text()
    log(f"  headline: {headline!r}")
    assert "nodes" in headline, headline

    canvas = page.locator('[data-testid="graph-canvas"]')
    expect(canvas).to_have_attribute("role", "application")
    label = canvas.get_attribute("aria-label")
    log(f"  aria-label: {label!r}")
    assert label is not None and "Dependency graph" in label, label

    # Read the rendered Cytoscape state via window-side JS so the assertion
    # is independent of paint timing.
    cy_state = page.evaluate(
        """() => {
            const el = document.querySelector('[data-testid="graph-canvas"]');
            const cy = el && el._cyreg && el._cyreg.cy;
            if (!cy) return null;
            return {
                nodes: cy.nodes().length,
                edges: cy.edges().length,
                dead: cy.nodes('.dead').length,
                entry: cy.nodes('.entry').length,
            };
        }"""
    )
    log(f"  cytoscape state: {cy_state}")
    assert cy_state is not None and cy_state["nodes"] > 0


def scenario_j2_zoom_and_drag(page: Page) -> None:
    log("J2: zoom, drag, and fit hotkey")
    page.goto(FRONTEND_URL)
    page.wait_for_load_state("networkidle")
    upload(page, FIXTURES / "simple.zip")
    wait_for_main(page)

    canvas_box = page.locator('[data-testid="graph-canvas"]').bounding_box()
    assert canvas_box is not None
    cx = canvas_box["x"] + canvas_box["width"] / 2
    cy = canvas_box["y"] + canvas_box["height"] / 2

    # Wheel zoom in.
    zoom_before = page.evaluate(
        "() => document.querySelector('[data-testid=\"graph-canvas\"]')._cyreg.cy.zoom()"
    )
    page.mouse.move(cx, cy)
    page.mouse.wheel(0, -800)
    page.wait_for_timeout(200)
    zoom_after = page.evaluate(
        "() => document.querySelector('[data-testid=\"graph-canvas\"]')._cyreg.cy.zoom()"
    )
    log(f"  zoom: {zoom_before:.3f} -> {zoom_after:.3f}")
    assert zoom_after > zoom_before, (zoom_before, zoom_after)
    shot(page, "j2-01-after-zoom.png")

    # Drag a node by 80 px down/right via Cytoscape API (mouse events on the
    # canvas would require precise pixel coordinates which Cytoscape's null-
    # safe layout makes flaky in headless runs). The drag listener still
    # fires `free` once the position changes.
    drag_result = page.evaluate(
        """() => {
            const el = document.querySelector('[data-testid="graph-canvas"]');
            const cy = el._cyreg.cy;
            const node = cy.nodes()[0];
            if (!node) return null;
            const before = { ...node.position() };
            node.position({ x: before.x + 80, y: before.y + 60 });
            node.emit('free');
            return { id: node.id(), before, after: { ...node.position() } };
        }"""
    )
    log(f"  drag result: {drag_result}")
    assert drag_result is not None

    # Wait for the debounced positions write to flush (500 ms in code).
    page.wait_for_timeout(800)
    positions_raw = page.evaluate(
        """() => {
            const keys = Object.keys(window.localStorage)
                .filter(k => k.endsWith(':positions'));
            return keys.length === 0 ? null : window.localStorage.getItem(keys[0]);
        }"""
    )
    log(f"  persisted positions[…0:120]: {(positions_raw or '')[:120]}")
    assert positions_raw is not None
    positions = json.loads(positions_raw)
    saved = positions.get(drag_result["id"])
    assert saved is not None and abs(saved["x"] - drag_result["after"]["x"]) < 1, saved

    # Press `f` to fit. Verify the call landed without throwing.
    page.locator('[data-testid="graph-canvas"]').focus()
    page.keyboard.press("f")
    page.wait_for_timeout(150)
    shot(page, "j2-02-after-fit.png")


def scenario_j3_positions_restored(page: Page) -> None:
    log("J3: drag a node, reload, verify position persisted")
    page.goto(FRONTEND_URL)
    page.wait_for_load_state("networkidle")
    upload(page, FIXTURES / "simple.zip")
    wait_for_main(page)

    moved = page.evaluate(
        """() => {
            const el = document.querySelector('[data-testid="graph-canvas"]');
            const cy = el._cyreg.cy;
            const node = cy.nodes()[0];
            if (!node) return null;
            node.position({ x: 600, y: 220 });
            node.emit('free');
            return { id: node.id(), pos: node.position() };
        }"""
    )
    log(f"  moved: {moved}")
    assert moved is not None
    page.wait_for_timeout(800)

    # Reload but keep localStorage. The shell starts at Landing on reload (no
    # URL routing in the MVP), so to revisit Main we use the recent-projects
    # restore link that the Landing page renders.
    page.reload()
    page.wait_for_load_state("networkidle")

    restore = page.locator('[data-testid^="landing-restore-"]').first
    if restore.count() == 0:
        log("  no recent-projects restore link; falling back to second upload")
        upload(page, FIXTURES / "simple.zip")
    else:
        restore.click()
    wait_for_main(page)

    after = page.evaluate(
        f"""() => {{
            const el = document.querySelector('[data-testid="graph-canvas"]');
            const cy = el._cyreg.cy;
            const node = cy.$id({moved["id"]!r});
            return node.nonempty() ? node.position() : null;
        }}"""
    )
    log(f"  after reload position: {after}")
    assert after is not None
    # Tolerate a couple of pixels of float drift from layout post-processing.
    assert abs(after["x"] - moved["pos"]["x"]) < 5, after
    assert abs(after["y"] - moved["pos"]["y"]) < 5, after
    shot(page, "j3-01-restored.png")


def main() -> int:
    reset_log()
    log("T20 E2E run starting")
    log(f"  fixtures: {FIXTURES}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1280, "height": 800})
        page = context.new_page()
        page.on(
            "console",
            lambda msg: log(f"  console[{msg.type}]: {msg.text}")
            if msg.type in {"error", "warning"}
            else None,
        )

        failures: list[str] = []
        for scenario in (
            scenario_j1_render,
            scenario_j2_zoom_and_drag,
            scenario_j3_positions_restored,
        ):
            try:
                context.unroute_all()
                context.clear_cookies()
                page.goto(FRONTEND_URL)
                page.evaluate("window.localStorage.clear()")
                scenario(page)
                log(f"  -> PASS: {scenario.__name__}")
            except Exception as exc:  # noqa: BLE001 - top-level reporter
                log(f"  -> FAIL: {scenario.__name__}: {exc}")
                shot(page, f"FAIL-{scenario.__name__}.png")
                failures.append(scenario.__name__)

        browser.close()

    if failures:
        log(f"T20 E2E run FAILED: {failures}")
        return 1
    log("T20 E2E run SUCCESS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
