# @e2e-dev/desktop

## 0.0.1

### Patch Changes

- [#1953](https://github.com/e2e-inc/e2e/pull/1953) [`a2d0363`](https://github.com/e2e-inc/e2e/commit/a2d0363128c95288b8e43d50029dc7a14b40c002) Thanks [@kdy1](https://github.com/kdy1)! - New package: `@e2e-dev/desktop`, the desktop engine. `engine: desktop()` drives a native app on macOS through agent-desktop's accessibility commands: observation, the `screen` locators and actions, test ids, secret fills over stdin, masked screenshots, and the `desktop` fixture. The app runs in the background and gets only a few variables of the run's environment. The engine downloads its pinned agent-desktop release on the first run.

- [#2056](https://github.com/e2e-inc/e2e/pull/2056) [`53f5cf6`](https://github.com/e2e-inc/e2e/commit/53f5cf603180e258c126f9afb6159f1cdd55ecf0) Thanks [@kdy1](https://github.com/kdy1)! - `desktop()` fixes. `e2e run --headed` launches the app in the foreground. `selectOption` refuses an editable combo box, `press` refuses a key agent-desktop cannot press, and a screenshot that cannot mask a password field fails with `POLICY_DENIED`. A read retries instead of passing as an empty screen, and keys and clicks no longer land on a control or window other than the one meant. `desktop()` returns `DesktopEngine`, so a config that infers its type declares under pnpm.
