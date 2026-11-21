/** Compile-time assertions for the handle `mobile()` returns: named by this package, accepted wherever an engine handle is. */
import type { EngineHandle } from '@e2e-dev/core/engine';
import { mobile, type MobileEngine, type MobileFixtures } from '../../src/index.ts';
import type { MobileEngine as EntryMobileEngine } from '../../src/engine-entry.ts';

void (mobile({ platform: 'ios' }) satisfies MobileEngine);
void (mobile({ platform: 'ios' }) satisfies EngineHandle<MobileFixtures>);
declare const handle: EngineHandle<MobileFixtures>;
void (handle satisfies MobileEngine);
void (handle satisfies EntryMobileEngine);

declare const device: import('../../src/index.ts').Device;
void device.pressRemote('menu');
// @ts-expect-error pressRemote takes the lowercase remote keys, not the keyboard's capitalised names
void device.pressRemote('Menu');
void ('play-pause' satisfies import('../../src/index.ts').RemoteKey);
