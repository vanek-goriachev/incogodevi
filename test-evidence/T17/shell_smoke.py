"""T17 frontend shell smoke test.

Verifies the App-shell scaffold from T17:
  * Landing screen renders by default with the top bar.
  * Theme selector toggles `data-theme="dark"` on the <html> element.
  * Routing buttons switch between Landing / Analyzing / Main screens.

Captures screenshots into the same directory for the PR evidence trail.
"""

from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

EVIDENCE_DIR = Path(__file__).parent
BASE_URL = "http://localhost:5173"


def main() -> int:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1280, "height": 720})
        page = context.new_page()
        page.goto(BASE_URL)
        page.wait_for_load_state("networkidle")
        page.wait_for_selector('[data-testid="app-shell"]')

        # 1. Landing screen visible by default.
        landing = page.locator('[data-testid="screen-landing"]')
        assert landing.is_visible(), "landing screen not visible on initial render"
        page.screenshot(path=str(EVIDENCE_DIR / "01-landing-light.png"), full_page=True)

        # 2. Theme switch → data-theme=dark.
        page.locator('[data-testid="theme-select"]').select_option("dark")
        page.wait_for_function(
            "document.documentElement.getAttribute('data-theme') === 'dark'"
        )
        attr = page.evaluate("document.documentElement.getAttribute('data-theme')")
        assert attr == "dark", f"expected data-theme=dark, got {attr!r}"
        page.screenshot(path=str(EVIDENCE_DIR / "02-landing-dark.png"), full_page=True)

        # 3. Navigation: Analyzing screen.
        page.get_by_role("button", name="Analyzing").click()
        analyzing = page.locator('[data-testid="screen-analyzing"]')
        analyzing.wait_for(state="visible")
        page.screenshot(path=str(EVIDENCE_DIR / "03-analyzing.png"), full_page=True)

        # 4. Navigation: Main screen → 3-column layout exposed.
        page.get_by_role("button", name="Main").click()
        page.locator('[data-testid="layout-left-rail"]').wait_for(state="visible")
        page.locator('[data-testid="layout-main"]').wait_for(state="visible")
        page.locator('[data-testid="layout-right-rail"]').wait_for(state="visible")
        page.screenshot(path=str(EVIDENCE_DIR / "04-main-layout.png"), full_page=True)

        # 5. Back to landing → click Landing in nav.
        page.get_by_role("button", name="Landing").click()
        page.locator('[data-testid="screen-landing"]').wait_for(state="visible")
        page.screenshot(path=str(EVIDENCE_DIR / "05-back-to-landing.png"), full_page=True)

        # 6. Toast: clicking "check API" surfaces a toast (success or error
        #    depending on whether the Go backend is up — both are acceptable
        #    proof that the toast pipeline works).
        page.get_by_role("button", name="check API").click()
        page.locator('[data-testid="toast-viewport"]').wait_for(state="visible")
        toast = page.locator(
            '[data-testid="toast-success"], [data-testid="toast-error"]'
        ).first
        toast.wait_for(state="visible", timeout=4000)
        page.screenshot(path=str(EVIDENCE_DIR / "06-toast.png"), full_page=True)

        browser.close()

    print("OK: T17 shell smoke test passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
