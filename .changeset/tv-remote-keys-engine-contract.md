---
'@e2e-dev/core': minor
'e2e': minor
---

**Breaking:** the engine contract's key grammar has TV remote keys, and `ParsedKey['key']` gains a third member, `{ kind: 'remote', name: RemoteKeyName }`. An engine that switches on `parsed.key.kind` exhaustively no longer compiles until it handles `'remote'`. `REMOTE_KEY_NAMES` lists the keys: `up`, `down`, `left`, `right`, `select`, `back`, `menu`, `home`, `play`, `pause`, `play-pause`, `stop`, `rewind`, `fast-forward`, `next`, and `previous`. They are lowercase, so `home` is the remote's Home button and `Home` stays the keyboard key.

An engine opts in with `remoteKeys: true`, carried in the engine protocol's manifest. On any other engine the harness refuses a remote key with `UNSUPPORTED_CAPABILITY` before it reaches the engine, naming the keyboard key of the same word when there is one, so an engine never receives a remote key it did not ask for. `press` and an executor's `pressKey` take the remote keys, and custom executors see the capability as `ctx.target.remoteKeys`. The replay cache records and replays them like any other key. An executor that lets an `UNSUPPORTED_CAPABILITY` from `pressKey` escape `runStep` fails `agent.act` with `POLICY_DENIED`, the original error as its `cause`, so catch it there to fall back. On a target whose engine declares `remoteKeys`, the built-in agent's `press` tool names the remote keys and sends them to the remote even when it names a node, and `press_at` presses a remote key without tapping the point first.
