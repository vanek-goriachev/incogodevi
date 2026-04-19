"""End-to-end smoke tests for T19 (Analyzing view + SSE consumer).

The script covers the three browser scenarios listed in
`tasks/T19-analyzing-view.md`:

  J1: Upload a real Go project ZIP -> land on the Analyzing screen ->
      observe the phase badges populate -> auto-navigate to Main on `done`.
      Backend is the real Go server hitting `testdata/simple`.

  J2: Stall the SSE stream via Playwright's request interceptor so the
      Cancel button has time to appear (3 s grace window). Click Cancel,
      verify the stream aborts and the UI flips to the "cancelled" panel
      with a Retry button. Click Retry to confirm the stream restarts.

  J3: Open Analyzing for a project id the backend has never seen. The
      first POST /analyze rejects 404 and the failure fallback renders
      with `data-error-code="project_not_found"`.

Artifacts (PNG screenshots + a single text log) land in this directory and
serve as proof for the T19 review on the merge PR.
"""

from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import Page, Route, expect, sync_playwright

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


def scenario_j1_upload_through_analyzing_to_main(page: Page) -> None:
    log("J1: upload simple.zip and observe Analyzing -> Main transition")
    page.goto(FRONTEND_URL)
    page.wait_for_load_state("networkidle")

    upload_via_input(page, FIXTURES / "simple.zip")
    page.wait_for_selector('[data-testid="screen-analyzing"]', timeout=15_000)
    # Capture the badge row at least once before the analysis completes.
    page.wait_for_selector('[data-testid="analyzing-phases"]', timeout=5_000)
    shot(page, "j1-01-analyzing-badges.png")

    # `simple.zip` is tiny and the analyzer typically completes in <1s, so the
    # next assertion is the main-screen handoff that proves `done` fired.
    page.wait_for_selector('[data-testid="screen-main"]', timeout=15_000)
    shot(page, "j1-02-main-after-done.png")
    name = page.locator('[data-testid="main-project-name"]').inner_text()
    log(f"  main screen project name: {name}")
    assert "simple" in name.lower(), name


def scenario_j2_cancel_and_retry(page: Page) -> None:
    log("J2: stall the SSE stream, cancel, verify cancelled UI, retry")
    # Intercept /analyze so the stream never completes — simulates a long-running
    # project. The first call streams two `phase` events then stalls; the
    # second call (after Retry) does the same.
    call_count = {"n": 0}

    def fulfil_stream(route: Route) -> None:
        call_count["n"] += 1
        body = (
            "event: phase\n"
            'data: {"seq":1,"phase":"loading"}\n\n'
            "event: phase\n"
            'data: {"seq":2,"phase":"parsing","progress":0.2}\n\n'
        )
        # Returning a fixed body without `done` keeps the React state on the
        # streaming branch indefinitely.
        route.fulfill(
            status=200,
            headers={
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
            body=body,
        )

    page.route("**/api/projects/*/analyze", fulfil_stream)

    # Seed router state by injecting it through the same window the SPA uses.
    # The simplest reliable way is via the Landing -> upload happy path so
    # the navigation event carries projectId.
    page.goto(FRONTEND_URL)
    page.wait_for_load_state("networkidle")
    upload_via_input(page, FIXTURES / "simple.zip")
    page.wait_for_selector('[data-testid="screen-analyzing"]', timeout=15_000)
    page.wait_for_selector('[data-testid="analyzing-phases"]', timeout=5_000)
    shot(page, "j2-01-streaming.png")

    # The Cancel button is hidden for ~3 s in production; wait it out.
    cancel = page.locator('[data-testid="analyzing-cancel"]')
    cancel.wait_for(state="visible", timeout=5_000)
    shot(page, "j2-02-cancel-visible.png")
    cancel.click()

    # The cancelled panel exposes a Retry button.
    retry = page.locator('[data-testid="analyzing-retry"]')
    retry.wait_for(state="visible", timeout=2_000)
    expect(page.locator("text=Analysis was cancelled")).to_be_visible()
    shot(page, "j2-03-cancelled.png")
    log(f"  observed {call_count['n']} analyze calls before retry")

    retry.click()
    page.wait_for_selector('[data-testid="analyzing-phases"]', timeout=2_000)
    shot(page, "j2-04-after-retry.png")
    assert call_count["n"] >= 2, call_count["n"]


def scenario_j3_pre_stream_failure(page: Page) -> None:
    log("J3: backend returns 404 for the analyze stream")

    # Force every analyze call to 404. The Landing page still uploads
    # successfully so we can navigate into Analyzing through the regular flow.
    def reject_with_404(route: Route) -> None:
        route.fulfill(
            status=404,
            content_type="application/json",
            body='{"error":{"code":"project_not_found","message":"gone"}}',
        )

    page.route("**/api/projects/*/analyze", reject_with_404)

    page.goto(FRONTEND_URL)
    page.wait_for_load_state("networkidle")
    upload_via_input(page, FIXTURES / "simple.zip")
    page.wait_for_selector('[data-testid="screen-analyzing"]', timeout=15_000)

    err = page.locator('[data-testid="analyzing-error"]')
    err.wait_for(state="visible", timeout=10_000)
    code = err.get_attribute("data-error-code")
    log(f"  failure code: {code!r}")
    assert code == "project_not_found", code
    shot(page, "j3-01-failed.png")


def main() -> int:
    reset_log()
    log("T19 E2E run starting")
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
            scenario_j1_upload_through_analyzing_to_main,
            scenario_j2_cancel_and_retry,
            scenario_j3_pre_stream_failure,
        ):
            try:
                # Each scenario starts with a clean storage state and an
                # empty interceptor table.
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
        log(f"T19 E2E run FAILED: {failures}")
        return 1
    log("T19 E2E run SUCCESS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
