import os
from playwright.sync_api import sync_playwright

BASE = os.environ.get("WAZIR_PORTAL_URL", "https://wazir-portal.pages.dev")
EXEC_PATH = os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH") or None
OUT = os.environ.get("WAZIR_SCREENSHOT_DIR", "test/reports/screenshots")
os.makedirs(OUT, exist_ok=True)

with sync_playwright() as p:
    launch_kwargs = {"executable_path": EXEC_PATH} if EXEC_PATH else {}
    browser = p.chromium.launch(**launch_kwargs)
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

            if name == "home" and label == "desktop":
                assert page.locator("#comp-grid .comp-btn").count() == 9, "Expected 9 interactive components"
                page.click("#comp-grid .comp-btn:nth-child(4)")
                assert "Model Router" in page.locator("#comp-detail").inner_text()
                assert page.locator("#topo-svg").is_visible(), "Fleet topology SVG must be visible"
                page.fill("#demo-search", "linux")
                assert "Linux" in (page.locator("#topo-svg").text_content() or "")
                page.fill("#demo-search", "")
                assert page.locator("#onboarding-steps .comp-btn").count() == 8, "Expected 8 onboarding steps"
                page.click("#onboarding-steps .comp-btn:nth-child(6)")
                assert "Natural-Language Task" in page.locator("#onboarding-detail").inner_text()
                assert page.locator("#credits-notices").is_visible(), "Credits & notices must be visible"

            if name == "download" and label == "desktop":
                # Test hero OS selector
                page.select_option("#hero-os-select", "linux-deb")
                assert "wazir_0.4.1_all.deb" in (page.locator("#hero-primary-btn").get_attribute("href") or "")
                page.select_option("#hero-os-select", "macos")
                assert "Wazir-Shell-0.4.1-macos-arm64.tar.gz" in (page.locator("#hero-primary-btn").get_attribute("href") or "")

                # Test arch selector
                page.select_option("#desktop-arch", "x64")
                assert "Linux" in page.locator("#desktop-downloads").inner_text()
                page.select_option("#desktop-arch", "arm64")
                assert "Wazir Shell" in page.locator("#desktop-downloads").inner_text()

                # Verify release history table hydrated
                assert page.locator("#release-history").is_visible()
                assert page.locator("#manifest-artifact-list tr").count() >= 5

                # Test terminal platform tabs & copy button
                page.click('[data-plat="debian"]')
                assert "dpkg -i" in page.locator("#term-cmd").inner_text()
                page.click("#copy-cmd-btn")
                page.wait_for_function("document.getElementById('copy-cmd-btn').innerText === 'Copied'", timeout=3000)
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
