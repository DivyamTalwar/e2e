---
'e2e': patch
'@e2e-dev/core': patch
---

`open_session {attach: true}` on `e2e mcp` also attaches to a test held at
a step in an `e2e run --step` without a terminal.
