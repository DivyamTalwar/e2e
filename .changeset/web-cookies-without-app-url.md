---
"@e2e-dev/web": patch
---

`browser.setCookies` sets a cookie that names a full `url` or a `domain` on a target with no `app.url`, such as `attachBrowser`; it failed with `APP_URL_REQUIRED` before. A cookie with neither now fails with `INVALID_ARGUMENT` naming the cookie.
