/**
 * Two gates in here are the difference between a normal test run and one that
 * reaches out to the release server, or worse: `quitAndInstall` in the middle of
 * a developer's session. `isPackaged` and `FREEBUFF_DISABLE_UPDATE_CHECK` both
 * have to hold on their own, so each is pinned separately. The rest of the file
 * is the UX contract around electron-updater: the user's "Skip This Version"
 * must survive a restart, a background check must never nag, and every way an
 * install can fail must still end at a manual download rather than silence.
 *
 * `init()` reaches for `require('electron')` and `require('electron-updater')`
 * itself, so there is no injection seam — electron is replaced with a plain
 * object (it does not exist under bun at all), while the packaged updater is a
 * REAL file in a temp `resourcesPath`, which is what lets the two require
 * branches be told apart. `init()` also memoizes a module-level singleton, so
 * each boot() re-requires updater.cjs from a cleared require cache.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const UPDATER = path.join(import.meta.dir, 'updater.cjs')

interface DialogOptions {
  message: string
  detail?: string
  buttons: string[]
  cancelId?: number
}

class FakeAutoUpdater extends EventEmitter {
  autoDownload?: boolean
  autoInstallOnAppQuit?: boolean
  autoRunAppAfterInstall?: boolean
  disableWebInstaller?: boolean
  logger?: unknown
  checks = 0
  downloads = 0
  quitArgs: unknown[][] = []
  checkImpl: () => unknown = () => ({ isUpdateAvailable: false })
  downloadImpl: () => Promise<unknown> = async () => ({})
  quitImpl: () => void = () => {}

  async checkForUpdates() {
    this.checks++
    return this.checkImpl()
  }
  downloadUpdate() {
    this.downloads++
    return this.downloadImpl()
  }
  quitAndInstall(...args: unknown[]) {
    this.quitArgs.push(args)
    this.quitImpl()
  }
  // bun freezes a mocked module's exports on first require, so these two live for the whole file and
  // are reset per test rather than replaced
  reset() {
    this.removeAllListeners()
    this.autoDownload = undefined
    this.autoInstallOnAppQuit = undefined
    this.autoRunAppAfterInstall = undefined
    this.disableWebInstaller = undefined
    this.logger = undefined
    this.checks = 0
    this.downloads = 0
    this.quitArgs = []
    this.checkImpl = () => ({ isUpdateAvailable: false })
    this.downloadImpl = async () => ({})
    this.quitImpl = () => {}
  }
}

let dialogs: DialogOptions[] = []
let answers: number[] = []
let opened: string[] = []
let userData = ''

// electron does not exist under bun and init() requires it directly, so this stands in for it. The
// objects are stable for the whole file (bun freezes a mocked module's exports on first require);
// each method reads the per-test state above.
mock.module('electron', () => ({
  app: { getPath: (name: string) => (name === 'userData' ? userData : path.join(userData, name)) },
  dialog: {
    showMessageBox: async (_parent: unknown, options: DialogOptions) => {
      dialogs.push(options)
      // default to the cancelling button, so a test that forgets to answer cannot start a download
      return { response: answers.length ? answers.shift()! : (options.cancelId ?? 0) }
    },
  },
  shell: { openExternal: async (url: string) => void opened.push(url) },
}))

/** the dev branch: `require('electron-updater')` out of node_modules */
const devUpdater = new FakeAutoUpdater()
mock.module('electron-updater', () => ({ autoUpdater: devUpdater }))

/** the packaged branch: a REAL file at `resourcesPath/electron-updater.cjs`, so the two require
 *  branches can be told apart by which fake ends up configured */
const packagedUpdater = new FakeAutoUpdater()
const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-resources-'))
fs.writeFileSync(
  path.join(resourcesDir, 'electron-updater.cjs'),
  'module.exports = { get autoUpdater() { return globalThis.__freebuffPackagedAutoUpdater } }\n',
)

/** let every already-queued continuation run — a real macrotask, not a guessed number of ticks */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const restores: (() => void)[] = []

/** process.platform / arch / execPath / resourcesPath are read at init and at install time */
function stubProcess(prop: string, value: string) {
  const previous = Object.getOwnPropertyDescriptor(process, prop)
  Object.defineProperty(process, prop, { value, configurable: true, writable: true })
  restores.push(() => {
    if (previous) Object.defineProperty(process, prop, previous)
    else delete (process as unknown as Record<string, unknown>)[prop]
  })
}

interface Booted {
  updater: FakeAutoUpdater
  /** what the module scheduled: [delay, callback] pairs */
  timeouts: { delay: number; run: () => void }[]
  intervals: { delay: number; run: () => void }[]
  checkNow: (opts?: { interactive?: boolean }) => Promise<void>
  handle: unknown
}

interface BootOptions {
  isPackaged?: boolean
  currentVersion?: string
  disableCheck?: boolean
  releaseFlavor?: 'standard' | 'baseline'
  /** simulates the window having gone away mid-install */
  window?: { setProgressBar: (fraction: number) => void } | null
}

const progress: number[] = []

function boot(options: BootOptions = {}): Booted {
  const {
    isPackaged = true,
    currentVersion = '1.0.0',
    disableCheck = false,
    releaseFlavor = 'standard',
  } = options
  const window =
    options.window === undefined
      ? { setProgressBar: (fraction: number) => progress.push(fraction) }
      : options.window

  if (disableCheck) process.env.FREEBUFF_DISABLE_UPDATE_CHECK = '1'
  else delete process.env.FREEBUFF_DISABLE_UPDATE_CHECK

  const timeouts: { delay: number; run: () => void }[] = []
  const intervals: { delay: number; run: () => void }[] = []
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void, delay: number) => {
    timeouts.push({ run, delay })
    return { unref: () => {} }
  }) as never)
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((run: () => void, delay: number) => {
    intervals.push({ run, delay })
    return { unref: () => {} }
  }) as never)

  let handle: { checkNow: (opts?: { interactive?: boolean }) => Promise<void> }
  try {
    delete require.cache[UPDATER]
    handle = require(UPDATER).init({
      currentVersion,
      isPackaged,
      releaseFlavor,
      getWindow: () => window,
    })
  } finally {
    timer.mockRestore()
    interval.mockRestore()
  }

  return {
    updater: isPackaged ? packagedUpdater : devUpdater,
    timeouts,
    intervals,
    checkNow: (opts) => handle.checkNow(opts),
    handle,
  }
}

/** an update is waiting; the returned boot is one `checkNow` away from the prompt */
function bootWithUpdate(version = '2.0.0', options: BootOptions = {}): Booted {
  const booted = boot(options)
  booted.updater.checkImpl = () => ({ isUpdateAvailable: true, updateInfo: { version } })
  return booted
}

function stateFile(): string {
  return path.join(userData, 'update-state.json')
}

beforeEach(() => {
  const inheritedGate = process.env.FREEBUFF_DISABLE_UPDATE_CHECK
  restores.push(() => {
    if (inheritedGate === undefined) delete process.env.FREEBUFF_DISABLE_UPDATE_CHECK
    else process.env.FREEBUFF_DISABLE_UPDATE_CHECK = inheritedGate
  })
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'freebuff-userdata-'))
  dialogs = []
  answers = []
  opened = []
  progress.length = 0
  devUpdater.reset()
  packagedUpdater.reset()
  ;(globalThis as Record<string, unknown>).__freebuffPackagedAutoUpdater = packagedUpdater
  stubProcess('resourcesPath', resourcesDir)
  // the module logs through console; keep the suite output readable
  for (const level of ['debug', 'info', 'warn', 'error'] as const) {
    const spy = spyOn(console, level).mockImplementation(() => {})
    restores.push(() => spy.mockRestore())
  }
})

afterEach(() => {
  // LIFO: a test that re-stubs a property it already stubbed (execPath, below) records two
  // restores, and unwinding them in order would leave the stub installed for every later FILE
  for (const restore of restores.splice(0).reverse()) restore()
  delete (globalThis as Record<string, unknown>).__freebuffPackagedAutoUpdater
  fs.rmSync(userData, { recursive: true, force: true })
  delete require.cache[UPDATER]
})

afterAll(() => {
  fs.rmSync(resourcesDir, { recursive: true, force: true })
})

describe('the dev gate', () => {
  test('an unpackaged app schedules nothing and checks nothing', async () => {
    // every `bun test` run and every `bun run app` is this branch: a check here talks to the release
    // server, and an accepted prompt would quitAndInstall over the developer's checkout
    const b = boot({ isPackaged: false })
    expect(b.timeouts).toEqual([])
    expect(b.intervals).toEqual([])

    await b.checkNow()
    expect(b.updater.checks).toBe(0)
    expect(dialogs).toEqual([])
  })

  test('an explicit check in dev says why instead of doing nothing', async () => {
    // the menu item is always enabled; silence would read as "checked, nothing found"
    const b = boot({ isPackaged: false })
    await b.checkNow({ interactive: true })
    expect(b.updater.checks).toBe(0)
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0].message).toMatch(/development/i)
  })
})

describe('the FREEBUFF_DISABLE_UPDATE_CHECK gate', () => {
  test('a packaged build with the env var set never schedules a check', async () => {
    // the e2e harness runs the packaged app; a background prompt there steals focus mid-test, and an
    // accepted one replaces the binary under test
    const b = boot({ disableCheck: true })
    expect(b.timeouts).toEqual([])
    expect(b.intervals).toEqual([])
    expect(b.updater.checks).toBe(0)
  })

  test('it disables the schedule, not the menu item', async () => {
    // the var means "do not check on your own", so an explicit user request still works
    const b = bootWithUpdate('2.0.0', { disableCheck: true })
    await b.checkNow({ interactive: true })
    expect(b.updater.checks).toBe(1)
  })
})

describe('scheduling', () => {
  test('a packaged build checks shortly after launch and then periodically', async () => {
    // the first check is deliberately deferred rather than run at t=0: launch is already spending
    // its CPU on the orchestrator and the first paint, and a prompt there lands on a half-drawn app
    const b = boot()
    expect(b.timeouts.map((t) => t.delay)).toEqual([12_000])
    expect(b.intervals.map((t) => t.delay)).toEqual([6 * 60 * 60 * 1000])
  })

  test('both scheduled checks are background ones — no dialog when there is nothing to install', async () => {
    // these fire with no user waiting on them; an "up to date" box would be a popup out of nowhere
    // at launch and then again every six hours, forever
    const b = boot()
    b.timeouts[0].run()
    await flush()
    expect(b.updater.checks).toBe(1)

    b.intervals[0].run()
    await flush()
    expect(b.updater.checks).toBe(2)
    expect(dialogs).toEqual([])
  })

  test('init is idempotent, so a dock re-activate cannot double the timers', async () => {
    // main.cjs re-runs boot() when macOS re-activates the app with no window open
    const b = boot()
    const again = require(UPDATER).init({
      currentVersion: '9.9.9',
      isPackaged: true,
      getWindow: () => null,
    })
    expect(again).toBe(b.handle)
    expect(b.timeouts).toHaveLength(1)
    expect(b.intervals).toHaveLength(1)
  })

  test('the packaged build loads the updater bundled into resources, not node_modules', async () => {
    // electron-builder ships no node_modules (`"!**/node_modules/**"`), so a packaged require of
    // 'electron-updater' would throw at startup and there would be no updates at all
    boot({ isPackaged: true })
    expect(packagedUpdater.autoDownload).toBe(false)
    expect(devUpdater.autoDownload).toBeUndefined()

    boot({ isPackaged: false })
    expect(devUpdater.autoDownload).toBe(false)
  })
})

describe('checking', () => {
  test('being up to date is reported only when the user asked', async () => {
    const b = boot()
    await b.checkNow()
    expect(dialogs).toEqual([])

    await b.checkNow({ interactive: true })
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0].detail).toContain('1.0.0')
  })

  test('a failed check is silent in the background and reported when interactive', async () => {
    const b = boot()
    b.updater.checkImpl = () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }
    await b.checkNow()
    expect(dialogs).toEqual([])

    await b.checkNow({ interactive: true })
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0].message).toMatch(/could not check/i)
  })

  test('a failed check does not wedge the checker', async () => {
    // the in-flight flag is cleared in a `finally`; leaving it set would mean one offline moment
    // disables updates until the app is restarted
    const b = boot()
    b.updater.checkImpl = () => {
      throw new Error('offline')
    }
    await b.checkNow()

    b.updater.checkImpl = () => ({ isUpdateAvailable: true, updateInfo: { version: '2.0.0' } })
    await b.checkNow()
    expect(b.updater.checks).toBe(2)
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0].message).toContain('2.0.0')
  })

  test('a check that arrives while one is running is dropped', async () => {
    // the 6-hourly timer and the menu item can land together; two in-flight checks means two prompts
    // for the same version
    const b = boot()
    const gate = deferred<{ isUpdateAvailable: boolean }>()
    b.updater.checkImpl = () => gate.promise

    const first = b.checkNow()
    await Promise.resolve()
    await b.checkNow({ interactive: true })
    expect(b.updater.checks).toBe(1)

    gate.resolve({ isUpdateAvailable: false })
    await first
  })

  test('a malformed check result is treated as "no update", not as one', async () => {
    // an update server that answers with nothing useful must not produce a prompt for `undefined`
    const b = boot()
    b.updater.checkImpl = () => null
    await b.checkNow()
    expect(dialogs).toEqual([])
  })
})

describe('the update prompt', () => {
  test('"Skip This Version" silences that version across restarts, but not the next one', async () => {
    const first = bootWithUpdate('2.0.0')
    answers = [1] // Skip This Version
    await first.checkNow()
    // every branch below dispatches on the button INDEX, so the index→label mapping is the
    // contract: reorder these and "Skip" starts installing
    expect(dialogs[0].buttons).toEqual(['Install', 'Skip This Version', 'Remind Me Later'])
    expect(JSON.parse(fs.readFileSync(stateFile(), 'utf8'))).toEqual({ skippedVersion: '2.0.0' })

    // a fresh process: the decision has to come off disk, not out of a live variable
    dialogs = []
    const restarted = bootWithUpdate('2.0.0')
    await restarted.checkNow()
    expect(dialogs).toEqual([])

    const newer = bootWithUpdate('2.1.0')
    await newer.checkNow()
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0].message).toContain('2.1.0')
  })

  test('an explicit check still shows a version the user skipped', async () => {
    // "Skip" suppresses nagging, not the menu item — otherwise a skipped version can never be
    // installed without editing update-state.json by hand
    fs.writeFileSync(stateFile(), JSON.stringify({ skippedVersion: '2.0.0' }))
    const b = bootWithUpdate('2.0.0')
    await b.checkNow({ interactive: true })
    expect(dialogs).toHaveLength(1)
    expect(dialogs[0].message).toContain('2.0.0')
  })

  test('"Remind Me Later" persists nothing, so the next check asks again', async () => {
    const b = bootWithUpdate('2.0.0')
    answers = [2]
    await b.checkNow()
    expect(fs.existsSync(stateFile())).toBe(false)
    // dismissing the box (Esc) has to land on this same button, not on Install
    expect(dialogs[0].buttons[dialogs[0].cancelId!]).toBe('Remind Me Later')

    await b.checkNow()
    expect(dialogs).toHaveLength(2)
    expect(b.updater.downloads).toBe(0)
  })

  test('a corrupt state file does not suppress every future update', async () => {
    // a half-written file (a crash during save) must degrade to "nothing skipped", not to a throw
    // inside the background check
    fs.writeFileSync(stateFile(), '{"skippedVersion":')
    const b = bootWithUpdate('2.0.0')
    await b.checkNow()
    expect(dialogs).toHaveLength(1)
  })

  test('an unwritable userData directory does not break the prompt', async () => {
    // best-effort persistence: the worst outcome of a failed write is being asked again
    fs.rmSync(userData, { recursive: true, force: true })
    const b = bootWithUpdate('2.0.0')
    answers = [1]
    await b.checkNow()
    expect(dialogs).toHaveLength(1)
  })
})

describe('installing', () => {
  // pin the host out of the picture: on macOS an execPath that is not inside a .app bundle takes the
  // translocation branch below, so these tests would otherwise mean different things per platform
  beforeEach(() => {
    stubProcess('platform', 'darwin')
    stubProcess('arch', 'arm64')
    stubProcess('execPath', '/Applications/Freebuff.app/Contents/MacOS/Freebuff')
  })

  test('the updater never downloads or installs behind the user’s back', async () => {
    // autoInstallOnAppQuit would apply an update the user answered "Remind Me Later" to, on the next
    // ordinary quit; autoDownload would spend their bandwidth before the prompt
    const b = boot()
    expect(b.updater.autoDownload).toBe(false)
    expect(b.updater.autoInstallOnAppQuit).toBe(false)
    expect(b.updater.disableWebInstaller).toBe(true)
    expect(b.updater.autoRunAppAfterInstall).toBe(true)
  })

  test('"Install" downloads and then relaunches into the installer', async () => {
    const b = bootWithUpdate()
    answers = [0]
    await b.checkNow()
    expect(b.updater.downloads).toBe(1)
    // (isSilent=false, isForceRunAfter=true): the user gets the app back after the restart
    expect(b.updater.quitArgs).toEqual([[false, true]])
    expect(opened).toEqual([])
  })

  test('download progress drives the taskbar and stops when the download does', async () => {
    const b = bootWithUpdate()
    answers = [0]
    const started = deferred()
    const finish = deferred()
    b.updater.downloadImpl = () => {
      started.resolve()
      return finish.promise
    }

    const done = b.checkNow()
    await started.promise
    b.updater.emit('download-progress', { percent: 42 })
    // a provider that reports no total sends percent: NaN — Infinity or NaN on the taskbar is a
    // stuck progress bar
    b.updater.emit('download-progress', { percent: NaN })
    expect(progress).toEqual([0.42, 0])

    finish.resolve()
    await done
    expect(progress).toEqual([0.42, 0, -1]) // -1 clears the bar

    // the listener is per-install; leaking one means a later download drives the bar twice
    b.updater.emit('download-progress', { percent: 90 })
    expect(progress).toEqual([0.42, 0, -1])
  })

  test('a failed download offers a manual download and can be retried', async () => {
    const b = bootWithUpdate()
    answers = [0, 0] // Install, then Download in Browser
    b.updater.downloadImpl = async () => {
      throw new Error('net::ERR_CONNECTION_RESET')
    }

    await b.checkNow()
    expect(progress.at(-1)).toBe(-1)
    expect(dialogs.at(-1)!.message).toMatch(/failed to install/i)
    expect(dialogs.at(-1)!.detail).toContain('net::ERR_CONNECTION_RESET')
    // answered by index, so the labels are the contract
    expect(dialogs.at(-1)!.buttons).toEqual(['Download in Browser', 'Cancel'])
    expect(opened).toEqual(['https://freebuff.com/api/desktop/download/mac-arm64'])

    // the in-flight flag has to be cleared or the app can never try again without a restart
    b.updater.downloadImpl = async () => ({})
    answers = [0]
    await b.checkNow()
    expect(b.updater.quitArgs).toHaveLength(1)
  })

  test('declining or dismissing the manual download opens nothing', async () => {
    const b = bootWithUpdate()
    b.updater.downloadImpl = async () => {
      throw new Error('boom')
    }

    answers = [0, 1] // Install, then Cancel
    await b.checkNow()
    expect(opened).toEqual([])

    // and Esc on the failure box must land on Cancel too: `answers` runs out after Install, so the
    // fake falls through to whatever cancelId the module set
    answers = [0]
    await b.checkNow()
    expect(dialogs.at(-1)!.message).toMatch(/failed to install/i)
    expect(opened).toEqual([])
  })

  test('an install failure that arrives as an event still reaches the manual fallback', async () => {
    // on macOS the verified ZIP is handed to Squirrel after downloadUpdate resolves, and that final
    // native step reports failure by emitting 'error' — nothing rejects
    const b = bootWithUpdate()
    answers = [0, 0]
    await b.checkNow()
    expect(dialogs).toHaveLength(1)

    b.updater.emit('error', new Error('ditto: Couldn’t posix_spawn'))
    await flush()
    expect(dialogs.at(-1)!.message).toMatch(/failed to install/i)
    expect(opened).toEqual(['https://freebuff.com/api/desktop/download/mac-arm64'])
  })

  test('a quitAndInstall that throws falls back once, not twice', async () => {
    // the late-error listener is registered before quitAndInstall; if the throw path did not remove
    // it, a later 'error' would open a second dialog on top of the first
    const b = bootWithUpdate()
    answers = [0, 1]
    b.updater.quitImpl = () => {
      throw new Error('EACCES')
    }
    await b.checkNow()
    expect(dialogs.filter((d) => /failed to install/i.test(d.message))).toHaveLength(1)
    expect(b.updater.listenerCount('error')).toBe(0)
  })

  test('a check that fires mid-install is ignored', async () => {
    // the 6-hourly timer during a long download would otherwise prompt for the same version again
    // and start a second download over the first
    const b = bootWithUpdate()
    answers = [0]
    const started = deferred()
    const finish = deferred()
    b.updater.downloadImpl = () => {
      started.resolve()
      return finish.promise
    }

    const done = b.checkNow()
    await started.promise
    await b.checkNow({ interactive: true })
    expect(b.updater.checks).toBe(1)
    expect(b.updater.downloads).toBe(1)

    finish.resolve()
    await done
  })

  test('a window that closed mid-install does not break the install', async () => {
    // setProgressBar on a destroyed BrowserWindow throws; the install itself must survive it
    const b = bootWithUpdate('2.0.0', {
      window: {
        setProgressBar: () => {
          throw new Error('Object has been destroyed')
        },
      },
    })
    answers = [0]
    await b.checkNow()
    expect(b.updater.quitArgs).toEqual([[false, true]])
  })
})

describe('the manual download link', () => {
  // the wrong link here hands a user a binary that will not run on their machine, and it is only
  // ever exercised on a path where the automatic update has already failed
  // (darwin/arm64 is not repeated here — the install-failure tests above already assert it)
  const cases: { platform: string; arch: string; url: string }[] = [
    { platform: 'darwin', arch: 'x64', url: 'https://freebuff.com/api/desktop/download/mac-intel' },
    { platform: 'win32', arch: 'x64', url: 'https://freebuff.com/api/desktop/download/windows' },
    { platform: 'linux', arch: 'x64', url: 'https://freebuff.com/api/desktop/download/linux' },
    { platform: 'freebsd', arch: 'x64', url: 'https://freebuff.com/desktop' },
  ]

  for (const { platform, arch, url } of cases) {
    test(`${platform}/${arch} is sent to ${url}`, async () => {
      stubProcess('platform', platform)
      stubProcess('arch', arch)
      stubProcess('execPath', '/Applications/Freebuff.app/Contents/MacOS/Freebuff')
      const b = bootWithUpdate()
      b.updater.downloadImpl = async () => {
        throw new Error('nope')
      }
      answers = [0, 0]
      await b.checkNow()
      expect(opened).toEqual([url])
    })
  }

  test('a baseline Windows build falls back to the compatible installer', async () => {
    stubProcess('platform', 'win32')
    stubProcess('arch', 'x64')
    const b = bootWithUpdate('2.0.0', { releaseFlavor: 'baseline' })
    b.updater.downloadImpl = async () => {
      throw new Error('nope')
    }
    answers = [0, 0]

    await b.checkNow()

    expect(opened).toEqual([
      'https://freebuff.com/api/desktop/download/windows-baseline',
    ])
  })
})

describe('macOS translocation', () => {
  beforeEach(() => {
    stubProcess('platform', 'darwin')
    stubProcess('arch', 'arm64')
  })

  // a bundle running from the DMG or from Gatekeeper's read-only quarantine copy cannot replace
  // itself: Squirrel reports success and the next launch is the same old build
  for (const execPath of [
    '/Volumes/Freebuff 1.0.0/Freebuff.app/Contents/MacOS/Freebuff',
    '/private/var/folders/x/AppTranslocation/ABC/d/Freebuff.app/Contents/MacOS/Freebuff',
  ]) {
    test(`a bundle at ${execPath.split('/')[1]} is sent to the installer instead of self-updating`, async () => {
      stubProcess('execPath', execPath)
      const b = bootWithUpdate()
      answers = [0, 0] // Install, then Download Installer
      await b.checkNow()

      expect(b.updater.downloads).toBe(0)
      expect(dialogs.at(-1)!.message).toMatch(/move freebuff to applications/i)
      expect(dialogs.at(-1)!.buttons).toEqual(['Download Installer', 'Cancel'])
      expect(opened).toEqual(['https://freebuff.com/api/desktop/download/mac-arm64'])
    })
  }

  test('an installed bundle updates itself', async () => {
    stubProcess('execPath', '/Applications/Freebuff.app/Contents/MacOS/Freebuff')
    const b = bootWithUpdate()
    answers = [0]
    await b.checkNow()
    expect(b.updater.downloads).toBe(1)
    expect(opened).toEqual([])
  })

  test('declining the move leaves the app installable again later', async () => {
    // the guard sets the in-flight flag before it returns; not clearing it would make every later
    // "Install" a no-op for the rest of the session
    stubProcess('execPath', '/Volumes/Freebuff/Freebuff.app/Contents/MacOS/Freebuff')
    const b = bootWithUpdate()
    // only Install is answered: dismissing the move box (Esc) must land on Cancel, not on the
    // download — the module's own cancelId decides that
    answers = [0]
    await b.checkNow()
    expect(dialogs.at(-1)!.message).toMatch(/move freebuff to applications/i)
    expect(opened).toEqual([])

    stubProcess('execPath', '/Applications/Freebuff.app/Contents/MacOS/Freebuff')
    answers = [0]
    await b.checkNow()
    expect(b.updater.downloads).toBe(1)
  })
})
