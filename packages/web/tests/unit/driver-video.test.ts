/**
 * `DriverVideo`: the driver's recording as the session drives it, over a
 * scripted Firefox peer. Nothing is recorded and no tab is sized until a
 * recording is asked for, a start records the tab shown then, and a start
 * its step gave up on is stopped again.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DriverVideo } from '../../src/driver/attempt-video.ts';
import { BidiVideo } from '../../src/driver/video.ts';
import { BROWSER_TRAITS } from '../../src/browsers.ts';
import { FakeBidi } from '../helpers/bidi-fake.ts';

const VIEWPORT = { width: 320, height: 200 };

describe('DriverVideo', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** A recording of the tab `shown` names, on a peer whose screencasts write a file each, counting the viewport reads. */
  function recording(shown: () => string | undefined) {
    const artifactsDir = mkdtempSync(path.join(tmpdir(), 'e2e-driver-video-'));
    dirs.push(artifactsDir);
    const bidi = new FakeBidi()
      .on('browsingContext.startScreencast', (params) => ({ result: { screencast: String(params['context']) } }))
      .on('browsingContext.stopScreencast', (params) => {
        const file = path.join(artifactsDir, `${String(params['screencast'])}.raw`);
        writeFileSync(file, 'webm');
        return { result: { path: file } };
      });
    const sized = { count: 0 };
    const video = new DriverVideo(() => new BidiVideo(bidi.connection, BROWSER_TRAITS.firefox, artifactsDir, {}, {}), {
      shown,
      viewport: async () => {
        sized.count += 1;
        return VIEWPORT;
      },
    });
    const recorded = () => bidi.commands('browsingContext.startScreencast').map((command) => command.params['context']);
    return { video, bidi, sized, recorded };
  }

  it('records nothing and sizes no tab until a recording is asked for', async () => {
    const { video, bidi, sized } = recording(() => 'tab-1');
    await video.contextOpened('tab-1');
    await video.contextClosing();
    await video.contextClosed();
    expect(await video.stop()).toEqual([]);
    await video.close();
    expect(sized.count).toBe(0);
    expect(bidi.sent).toEqual([]);
  });

  it('starts on the tab shown, then records every tab shown after it', async () => {
    const { video, recorded } = recording(() => 'tab-1');
    await video.start(new AbortController().signal);
    await video.contextOpened('tab-2');
    expect(recorded()).toEqual(['tab-1', 'tab-2']);
    expect((await video.stop()).map((segment) => ('path' in segment ? segment.path : segment.url))).toEqual(['video/video.webm', 'video/video-part2.webm']);
  });

  it('only arms while no tab is shown, without sizing one, and the first tab shown starts the first segment', async () => {
    const { video, sized, recorded } = recording(() => undefined);
    await video.start(new AbortController().signal);
    expect(sized.count).toBe(0);
    expect(recorded()).toEqual([]);
    await video.contextOpened('tab-1');
    expect(recorded()).toEqual(['tab-1']);
    await video.close();
  });

  it('stops a start that finished after its step gave up, and records no tab shown after it', async () => {
    const { video, bidi, recorded } = recording(() => 'tab-1');
    const gaveUp = new AbortController();
    gaveUp.abort();
    await expect(video.start(gaveUp.signal)).rejects.toThrow();
    expect(bidi.commands('browsingContext.stopScreencast')).toHaveLength(1);
    await video.contextOpened('tab-2');
    expect(recorded()).toEqual(['tab-1']);
  });
});
