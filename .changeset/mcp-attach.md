---
'e2e': patch
'@e2e-dev/core': patch
---

While a test is paused, your coding agent can drive its browser or device
with `open_session {attach: true}` on `e2e mcp`. It also attaches to a test
held at a step in an `e2e run --step` without a terminal.
