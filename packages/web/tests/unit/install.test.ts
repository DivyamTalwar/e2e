import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { browserCheck, ensureBrowsersInstalled, installArgs } from '../../src/install.ts';
import type { BrowserName } from '../../src/browser-connection.ts';

describe('browserCheck', () => {
  const firstRun = [
    { id: 'browser', status: 'warn', message: 'firefox is not installed; the first run downloads it, or run "npx @e2e-dev/web install firefox" now' },
  ];

  it('passes an installed browser, warns of a first-run download, and reports nothing it cannot tell', async () => {
    expect(await browserCheck('chromium', {}, false, () => true)).toEqual([{ id: 'browser', status: 'pass', message: 'chromium is installed' }]);
    expect(await browserCheck('firefox', {}, false, () => false)).toEqual(firstRun);
    expect(await browserCheck('chromium', {}, false, () => undefined)).toEqual([]);
  });

  it('reads the verdict of a detection that answers later, not the promise', async () => {
    expect(await browserCheck('chromium', {}, false, async () => true)).toEqual([{ id: 'browser', status: 'pass', message: 'chromium is installed' }]);
    expect(await browserCheck('firefox', {}, false, async () => false)).toEqual(firstRun);
    expect(await browserCheck('chromium', {}, false, async () => undefined)).toEqual([]);
  });
});

describe('ensureBrowsersInstalled', () => {
  it('does nothing when every browser is installed', async () => {
    const installed: BrowserName[][] = [];
    const logs: string[] = [];
    await ensureBrowsersInstalled(['chromium', 'firefox'], {
      log: (line) => logs.push(line),
      isInstalled: () => true,
      install: async (names) => {
        installed.push([...names]);
      },
    });
    expect(installed).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('installs missing browsers once, deduplicated', async () => {
    const installed: BrowserName[][] = [];
    const logs: string[] = [];
    await ensureBrowsersInstalled(['chromium', 'firefox', 'chromium'], {
      log: (line) => logs.push(line),
      isInstalled: (name) => name === 'firefox',
      install: async (names) => {
        installed.push([...names]);
      },
    });
    expect(installed).toEqual([['chromium']]);
    expect(logs[0]).toContain('chromium');
    expect(logs[0]).not.toContain('firefox');
  });

  it('hands the progress log and the signal to the installer', async () => {
    const logs: string[] = [];
    const controller = new AbortController();
    await ensureBrowsersInstalled(['chromium'], {
      log: (line) => logs.push(line),
      isInstalled: () => false,
      signal: controller.signal,
      install: async (_names, context) => {
        expect(context.signal).toBe(controller.signal);
        context.log('|■■■■    |  50% of 171 MiB');
      },
    });
    expect(logs).toEqual([
      'Downloading missing Playwright browsers (first run): chromium...',
      '|■■■■    |  50% of 171 MiB',
      'Browser download complete.',
    ]);
  });

  it('installs against the run environment, not the process environment', async () => {
    const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '/run-specific/browsers' };
    const contexts: { env: NodeJS.ProcessEnv }[] = [];
    await ensureBrowsersInstalled(['chromium'], {
      log: () => {},
      isInstalled: () => false,
      env,
      install: async (_names, context) => {
        contexts.push({ env: context.env });
      },
    });
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.env['PLAYWRIGHT_BROWSERS_PATH']).toBe('/run-specific/browsers');
  });

  it('defers to the installer when the run points at another browser cache', async () => {
    // The default detection cannot see a cache this process was not started
    // with, so it declines a verdict: the CLI runs with the run's environment
    // and is a no-op when the cache is already complete, and the headline is
    // not printed because nothing is known to be missing.
    const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '/elsewhere/browsers' };
    const installed: BrowserName[][] = [];
    const logs: string[] = [];
    await ensureBrowsersInstalled(['chromium'], {
      log: (line) => logs.push(line),
      env,
      install: async (names, context) => {
        installed.push([...names]);
        expect(context.env['PLAYWRIGHT_BROWSERS_PATH']).toBe('/elsewhere/browsers');
      },
    });
    expect(installed).toEqual([['chromium']]);
    expect(logs).toEqual([]);
  });

  it('does not collect the browsers the declared cache holds', async () => {
    // The run spawns the install with the cache it was pointed at, and that
    // command removes every revision no installed Playwright declares. Those
    // revisions belong to the other tools sharing that cache.
    const contexts: { env: NodeJS.ProcessEnv }[] = [];
    await ensureBrowsersInstalled(['chromium'], {
      log: () => {},
      isInstalled: () => false,
      install: async (_names, context) => {
        contexts.push({ env: context.env });
      },
    });
    expect(contexts[0]?.env['PLAYWRIGHT_SKIP_BROWSER_GC']).toBe('1');
  });

  it('keeps a browser collection the caller asked for', async () => {
    const contexts: { env: NodeJS.ProcessEnv }[] = [];
    await ensureBrowsersInstalled(['chromium'], {
      log: () => {},
      isInstalled: () => false,
      env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_GC: '0' },
      install: async (_names, context) => {
        contexts.push({ env: context.env });
      },
    });
    expect(contexts[0]?.env['PLAYWRIGHT_SKIP_BROWSER_GC']).toBe('0');
  });

  it('asks for the shell only on a headless chromium run', () => {
    // The assertion the install runs on: a headless chromium run launches the
    // shell, so `--only-shell` keeps the full build out of its download. A headed
    // run launches the full build, and so does a browser that has no shell.
    expect(installArgs(['chromium'], false)).toEqual(['--only-shell', 'chromium']);
    expect(installArgs(['chromium'], true)).toEqual(['chromium']);
    expect(installArgs(['firefox'], false)).toEqual(['firefox']);
    expect(installArgs(['chromium', 'firefox'], false)).toEqual(['--only-shell', 'chromium', 'firefox']);
  });

  it('passes the run mode to the installer', async () => {
    const contexts: { headed: boolean }[] = [];
    await ensureBrowsersInstalled(['chromium'], {
      log: () => {},
      isInstalled: () => false,
      headed: true,
      install: async (_names, context) => {
        contexts.push({ headed: context.headed });
      },
    });
    expect(contexts[0]?.headed).toBe(true);
  });

  // The bug lived in the built-in detection, so it is exercised against a real
  // browser cache rather than an injected verdict. Playwright resolves its cache
  // when it is first loaded and this file has already loaded it, so the real
  // function runs in a child process started with the environment set up here.
  describe('the built-in detection', () => {
    // The revision the installed Playwright declares: the reported executable
    // names it, and a cache under another revision is not the one a run reads.
    const reported = chromium.executablePath();
    const revision = reported.slice(reported.lastIndexOf('chromium-') + 'chromium-'.length).split(path.sep)[0] ?? '';
    // The child runs the built package, the same one a user gets, so the check it
    // exercises is the one that ships.
    const built = createRequire(import.meta.url).resolve('../../dist/install.js');
    const packageDir = path.dirname(createRequire(import.meta.url).resolve('playwright-core/package.json'));
    let cache = '';
    let previous: string | undefined;

    /**
     * Runs the built-in check in a process started with `env`: whether nothing
     * would install, and whether the check imported Playwright to tell.
     */
    const probe = (
      headed: boolean,
      env: NodeJS.ProcessEnv = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache },
    ): { installed: boolean; loadedPlaywright: boolean } => {
      const probeFile = path.join(cache, 'probe.mjs');
      writeFileSync(
        probeFile,
        `import { registerHooks } from 'node:module';
let loadedPlaywright = false;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'playwright-core') loadedPlaywright = true;
    return next(specifier, context);
  },
});
const { ensureBrowsersInstalled } = await import(${JSON.stringify(built)});
let value = true;
const logs = [];
await ensureBrowsersInstalled(['chromium'], {
  headed: ${String(headed)},
  log: (line) => logs.push(line),
  install: async () => { value = logs.length > 0 ? false : undefined; },
});
console.log(JSON.stringify({ value: String(value), loadedPlaywright }));
`,
      );
      const child = spawnSync(process.execPath, [probeFile], {
        encoding: 'utf8',
        cwd: path.dirname(path.dirname(packageDir)),
        env,
      });
      if (child.status !== 0) throw new Error(`the detection probe failed: ${child.stderr}`);
      const { value, loadedPlaywright } = JSON.parse(child.stdout.trim()) as { value: string; loadedPlaywright: boolean };
      expect(value).not.toBe('undefined');
      return { installed: value === 'true', loadedPlaywright };
    };

    /** Runs the built-in check in a process that loaded Playwright with this cache; true when nothing would install. */
    const verdict = (headed: boolean): boolean => probe(headed).installed;

    // This platform's paths inside each build's directory, e.g. `chrome-linux64/chrome`
    // and `chrome-headless-shell-linux64/chrome-headless-shell`.
    const buildDir = `${path.sep}chromium-${revision}${path.sep}`;
    const fullRelative = reported.slice(reported.lastIndexOf(buildDir) + buildDir.length);
    const platformDir = fullRelative.split(path.sep)[0] ?? '';
    const shellRelative = path.join(
      platformDir.replace(/^chrome-/, 'chrome-headless-shell-'),
      process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell',
    );

    /** Lays out the builds named under `root`, each with its completion marker. */
    const layIn = (root: string, ...builds: readonly ('shell' | 'full')[]): void => {
      for (const build of builds) {
        const dir = build === 'shell' ? `chromium_headless_shell-${revision}` : `chromium-${revision}`;
        const exe = path.join(root, dir, build === 'shell' ? shellRelative : fullRelative);
        mkdirSync(path.dirname(exe), { recursive: true });
        writeFileSync(exe, '');
        writeFileSync(path.join(root, dir, 'INSTALLATION_COMPLETE'), '');
      }
    };

    /** Lays out the builds named in this test's cache. */
    const lay = (...builds: readonly ('shell' | 'full')[]): void => layIn(cache, ...builds);

    beforeEach(() => {
      cache = mkdtempSync(path.join(tmpdir(), 'e2e-browsers-'));
      previous = process.env['PLAYWRIGHT_BROWSERS_PATH'];
    });

    afterEach(() => {
      if (previous === undefined) delete process.env['PLAYWRIGHT_BROWSERS_PATH'];
      else process.env['PLAYWRIGHT_BROWSERS_PATH'] = previous;
      rmSync(cache, { recursive: true, force: true });
    });

    it('reads a shell-only cache as installed for a headless run', () => {
      // The full build executablePath() names is absent, which is what a run with
      // only the shell installed looks like.
      lay('shell');
      expect(verdict(false)).toBe(true);
    });

    it('reads a shell-only cache as missing for a headed run', () => {
      // A headed run launches the full build, and the shell is not that build.
      lay('shell');
      expect(verdict(true)).toBe(false);
    });

    it('reads a full-build-only cache as installed for a headed run', () => {
      lay('full');
      expect(verdict(true)).toBe(true);
    });

    it('reads a full-build-only cache as missing for a headless run', () => {
      // `playwright install --no-shell` leaves exactly this, and the headless
      // launch would then fail on the shell it never got.
      lay('full');
      expect(verdict(false)).toBe(false);
    });

    it('reads an empty cache as missing either way', () => {
      expect(verdict(false)).toBe(false);
      expect(verdict(true)).toBe(false);
    });

    it('answers a headless run from an installed shell without loading Playwright', () => {
      // The runner process never launches a browser, so importing Playwright
      // only to find the shell would cost every run its load time.
      lay('shell');
      expect(probe(false)).toEqual({ installed: true, loadedPlaywright: false });
    });

    it('asks Playwright when the cache holds no shell, or the run is headed', () => {
      expect(probe(false)).toEqual({ installed: false, loadedPlaywright: true });
      lay('full');
      expect(probe(false)).toEqual({ installed: false, loadedPlaywright: true });
      expect(probe(true)).toEqual({ installed: true, loadedPlaywright: true });
    });

    it('finds the shell under a relative cache path the way Playwright does', () => {
      // Playwright resolves a relative PLAYWRIGHT_BROWSERS_PATH against INIT_CWD,
      // which a package manager sets to the directory it was started in.
      const relative = path.join('nested', 'browsers');
      layIn(path.join(cache, relative), 'shell');
      expect(probe(false, { ...process.env, PLAYWRIGHT_BROWSERS_PATH: relative, INIT_CWD: cache })).toEqual({
        installed: true,
        loadedPlaywright: false,
      });
    });

    it('resolves a relative cache path against INIT_CWD spelled as npm config, as Playwright does', () => {
      // Playwright reads INIT_CWD through its npm config spellings too, so the
      // shell it would launch is under that directory, not the working one.
      const relative = path.join('nested', 'browsers');
      const project = path.join(cache, 'project');
      layIn(path.join(project, relative), 'shell');
      const env: NodeJS.ProcessEnv = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: relative, npm_config_init_cwd: project };
      delete env['INIT_CWD'];
      expect(probe(false, env)).toEqual({ installed: true, loadedPlaywright: false });
    });

    it('finds the shell in the per-user cache when no path is configured', () => {
      const home = path.join(cache, 'home');
      const userCache =
        process.platform === 'darwin'
          ? path.join(home, 'Library', 'Caches')
          : process.platform === 'win32'
            ? path.join(home, 'AppData', 'Local')
            : path.join(home, '.cache');
      layIn(path.join(userCache, 'ms-playwright'), 'shell');
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home };
      for (const name of ['PLAYWRIGHT_BROWSERS_PATH', 'npm_config_playwright_browsers_path', 'npm_package_config_playwright_browsers_path', 'XDG_CACHE_HOME', 'LOCALAPPDATA']) {
        delete env[name];
      }
      expect(probe(false, env)).toEqual({ installed: true, loadedPlaywright: false });
    });

    it("agrees with Playwright's own executable path on this machine's cache", () => {
      // Playwright's registry, the module its launch reads the path from.
      const { registry } = (createRequire(import.meta.url)('playwright-core/lib/coreBundle') as {
        registry: { registry: { findExecutable(name: string): { executablePath(): string } } };
      }).registry;
      const shell = registry.findExecutable('chromium-headless-shell').executablePath();
      const installed = existsSync(shell) && existsSync(path.join(path.dirname(path.dirname(shell)), 'INSTALLATION_COMPLETE'));
      expect(probe(false, { ...process.env })).toEqual({ installed, loadedPlaywright: !installed });
    });
  });
});
