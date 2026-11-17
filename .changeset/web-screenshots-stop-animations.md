---
"@e2e-dev/web": patch
---

Every web screenshot stops CSS animations, transitions, and `element.animate()` while it is taken: `app.screenshot()`, failure and agent evidence, and the pixels a model reads, as `toHaveScreenshot` already did. An animation inside a closed shadow root stops too. One that is paused, has a zero playback rate, or follows a scroll position is left as the page set it.
