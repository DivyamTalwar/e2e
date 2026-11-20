---
'@e2e-dev/core': minor
'e2e': minor
---

**Breaking:** the engine contract's key grammar has TV remote keys. `ParsedKey['key']` gains a third member, `{ kind: 'remote', name: RemoteKeyName }`, and `REMOTE_KEY_NAMES` lists the keys: `up`, `down`, `left`, `right`, `select`, `back`, `menu`, `home`, `play`, `pause`, `play-pause`, `stop`, `rewind`, `fast-forward`, `next`, and `previous`. The harness used to refuse these names with `INVALID_ARGUMENT`; now they reach every engine's `keyboard.press` and `perform({ kind: 'press' })`. An engine that switches on `parsed.key.kind` handles `'remote'`, and one that passes keys through to its platform refuses remote keys with `UNSUPPORTED_CAPABILITY` unless the platform has a remote.

`press` and an executor's `pressKey` take the remote keys. They are lowercase, so `home` is the remote's Home button and `Home` stays the keyboard key. The replay cache records and replays them like any other key. An executor that lets an `UNSUPPORTED_CAPABILITY` from `pressKey` escape `runStep` fails `agent.act` with `POLICY_DENIED`, the original error as its `cause`, so catch it there to fall back. On an iOS or Android target the built-in agent's `press` tool names the remote keys, and `press_at` presses a remote key without tapping the point first.
