# Remaining Blockers — Wazir Shell P0 Remediation

1. **WKWebView SVG `foreignObject` Canvas Tainting**: `captureDomPng` in `app.js` cannot export `canvas.toDataURL('image/png')` inside `WKWebView` due to WebKit's cross-origin tainting policy on `foreignObject`. Native functional verification (`COMMAND_EXECUTION_RESULTS.json`, `PERFORMANCE.csv`) ran and passed directly inside the compiled `wazir-shell` binary, but automated PNG screenshot capture from inside `WKWebView` is `BLOCKED` without an external screen-capture grant.
2. **Live Ubuntu Desktop Execution**: `.deb` packaging was built and verified on macOS, but live Ubuntu 24.04/26.04 GNOME desktop installation requires an Ubuntu host (`IMPLEMENTED_NOT_VERIFIED` on live Ubuntu).
