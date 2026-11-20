---
'e2e': patch
'@e2e-dev/core': patch
'@e2e-dev/mobile': patch
'@e2e-dev/web': patch
---

`app.launchArguments` and `device.openApp({ launchArguments })` also take an object of argument name to string, number, boolean, or list of strings on iOS, such as `{ AppleLanguages: ['fr'], AppleLocale: 'fr_FR' }`; `mobile()` sends each entry as `-name value`. Android still takes the list of `am start` arguments. An engine takes the object by listing `'named-launch-arguments'` in `appForms` and reads it as `EngineAppInfo.namedLaunchArguments`; `EngineAppInfo.launchArguments` stays a list, and the runner refuses the object at config load on an engine that does not list the form. `@e2e-dev/core/engine` exports `checkLaunchArguments`, the shape check.
