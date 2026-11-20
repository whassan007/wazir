import os
from playwright.sync_api import sync_playwright

BASE = os.environ.get("WAZIR_PORTAL_URL", "https://wazir-portal.pages.dev")
OUT = "test/reports/screenshots"
os.makedirs(OUT, exist_ok=True)

with sync_playwright() as p:
    browser = p.chromium.launch()
    errors = []

    def check_page(path, name, viewports):
        for label, vp in viewports:
            page = browser.new_page(viewport=vp)
            page_errors = []
            failed_reqs = []
            page.on("pageerror", lambda err: page_errors.append(str(err)))
            page.on("console", lambda msg: page_errors.append(msg.text) if msg.type == "error" else None)
            page.on("response", lambda res: failed_reqs.append(f"{res.status} {res.url}") if res.status >= 400 else None)

            page.goto(f"{BASE}{path}", wait_until="networkidle", timeout=30000)
            page.screenshot(path=f"{OUT}/wazir-{name}-{label}.png", full_page=False)
            assert page.locator("h1").is_visible(), f"H1 not visible on {path}"

            if name == "download" and label == "desktop":
                # Test arch selector
                page.select_option("#desktop-arch", "x64")
                assert "x86_64" in page.locator("#desktop-downloads").inner_text()
                page.select_option("#desktop-arch", "arm64")
                assert "Wazir Shell" in page.locator("#desktop-downloads").inner_text()

                # Test terminal platform tabs & copy button
                page.click('[data-plat="debian"]')
                assert "dpkg -i" in page.locator("#term-cmd").inner_text()
                page.click("#copy-cmd-btn")
                page.wait_for_timeout(150)
                assert page.locator("#copy-cmd-btn").inner_text() == "Copied"

                # Test FAQ accordion
                first_faq = page.locator("details.faq-item").first
                first_faq.locator("summary").click()
                assert first_faq.get_attribute("open") is not None

                # Test theme toggle
                page.click("#theme-toggle")
                assert page.locator("html").get_attribute("data-theme") == "dark"
                page.click("#theme-toggle")
                assert page.locator("html").get_attribute("data-theme") == "light"

            if page_errors or failed_reqs:
                errors.append((path, label, page_errors, failed_reqs))
            page.close()

    viewports = [
        ("desktop", {"width": 1440, "height": 900}),
        ("laptop", {"width": 1280, "height": 800}),
        ("tablet", {"width": 768, "height": 1024}),
        ("mobile", {"width": 390, "height": 844}),
    ]
    check_page("/", "home", viewports)
    check_page("/download", "download", viewports)
    browser.close()

    if errors:
        raise SystemExit(f"Browser QA failed: {errors}")
    print("Browser QA PASSED: 0 console errors, 0 failed assets, all interactive controls & 4 viewports verified.")
