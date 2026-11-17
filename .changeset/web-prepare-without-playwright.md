---
'@e2e-dev/web': patch
---

A headless Chromium run starts about 0.1 s sooner when the browser is already installed: the runner finds it on disk instead of loading Playwright to look it up.
