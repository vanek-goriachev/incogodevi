"""End-to-end smoke tests for T18 (Landing + Upload).

Spins up the full backend (Go) and frontend (Vite dev server) via
`scripts/with_server.py` and exercises three scenarios documented in
tasks/T18-landing-upload.md:

  J1: drop a valid Go ZIP -> upload progresses -> Analyzing screen appears
      with the project name returned by POST /api/projects.
  J2: drop an archive without go.mod -> inline error 'archive is missing
      go.mod at root' is shown and the user stays on the Landing screen.
  J3: reload the page after a successful upload -> recent-projects list
      contains the just-uploaded project.

Artifacts (PNG screenshots + a single text log) are saved alongside this
script under test-evidence/T18/. The script exits non-zero if any scenario
fails so the calling shell sees the failure.
"""

from __future__ import annotations

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


def upload_via_input(page: Page, file_path: Path) -> None:
    page.set_input_files('[data-testid="landing-file-input"]', str(file_path))


def scenario_j1_happy_path(page: Page) -> None:
    log("J1: drop a valid Go ZIP and reach the Analyzing screen")
    page.goto(FRONTEND_URL)
    page.wait_for_load_state("networkidle")
    shot(page, "j1-01-landing.png")

    # Trigger a drag-style overlay via the document-level listeners so the
    # screenshot proves the dragging affordance fires (the actual file drop
    # arrives via set_input_files, which Playwright wires reliably).
    page.evaluate(
        """
        const dt = new DataTransfer();
        const evt = new DragEvent('dragenter', {
            bubbles: true, cancelable: true, dataTransfer: dt,
        });
        Object.defineProperty(evt.dataTransfer, 'types', { value: ['Files'] });
        document.dispatchEvent(evt);
        """
    )
    page.wait_for_selector(".landing__zone--dragging")
    shot(page, "j1-02-dragging.png")
    page.evaluate(
        """
        const dt = new DataTransfer();
        const evt = new DragEvent('dragleave', {
            bubbles: true, cancelable: true, dataTransfer: dt,
        });
        Object.defineProperty(evt.dataTransfer, 'types', { value: ['Files'] });
        document.dispatchEvent(evt);
        """
    )

    upload_via_input(page, FIXTURES / "simple.zip")
    page.wait_for_selector('[data-testid="screen-analyzing"]', timeout=15_000)
    shot(page, "j1-03-analyzing.png")
    project_name = page.locator('[data-testid="analyzing-project"]').inner_text()
    log(f"  analyzing screen mentions: {project_name}")
    assert "simple" in project_name.lower(), project_name


def scenario_j2_missing_gomod(page: Page) -> None:
    log("J2: drop an archive without go.mod and surface the inline error")
    page.goto(FRONTEND_URL)
    page.wait_for_load_state("networkidle")

    upload_via_input(page, FIXTURES / "no-gomod.zip")

    err = page.locator('[data-testid="landing-error"]')
    err.wait_for(timeout=15_000)
    expect(err).to_contain_text("missing go.mod", ignore_case=True)
    code = err.get_attribute("data-error-code")
    log(f"  inline error visible, code={code!r}")
    assert code == "go_mod_missing", code
    shot(page, "j2-01-error.png")


def scenario_j3_recent_persists(page: Page) -> None:
    log("J3: recent-projects list survives a reload")
    page.goto(FRONTEND_URL)
    page.wait_for_load_state("networkidle")

    upload_via_input(page, FIXTURES / "simple.zip")
    page.wait_for_selector('[data-testid="screen-analyzing"]', timeout=15_000)

    page.goto(FRONTEND_URL)
    page.wait_for_load_state("networkidle")
    page.wait_for_selector('[data-testid="landing-recent-list"]')
    items = page.locator('[data-testid="landing-recent-list"] li').count()
    log(f"  recent-list items after reload: {items}")
    assert items >= 1, items
    shot(page, "j3-01-recent.png")


def main() -> int:
    reset_log()
    log("T18 E2E run starting")
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
            scenario_j1_happy_path,
            scenario_j2_missing_gomod,
            scenario_j3_recent_persists,
        ):
            try:
                # Each scenario gets a clean storage state so they are truly
                # independent (J3 deliberately re-uploads to seed the list).
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
        log(f"T18 E2E run FAILED: {failures}")
        return 1
    log("T18 E2E run SUCCESS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
