---
'@e2e-dev/mobile': patch
'@e2e-dev/web': patch
---

The mobile engine presses TV remote keys through agent-device's `tv-remote`, and `device.pressRemote(key)` presses one with no node to address. A device without the button rejects with `UNSUPPORTED_CAPABILITY`, and a name outside the list is `INVALID_ARGUMENT`. A refused keyboard key names the remote key to press instead. The web engine has no remote, so it refuses remote keys with `UNSUPPORTED_CAPABILITY`, naming the keyboard key of the same word when there is one.
