/**
 * Freebuff Desktop updater.
 *
 * electron-updater owns update discovery, integrity verification, download,
 * and platform-specific installation. This module supplies Freebuff's UX:
 * prompt before download, Install / Skip This Version / Remind Me Later,
 * taskbar progress, macOS translocation detection, and a manual-download
 * fallback on any install failure.
 */

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_DELAY_MS = 12 * 1000

let singleton = null

function macAppBundlePath(execPath) {
  const marker = '/Contents/MacOS/'
  const i = String(execPath).indexOf(marker)
  return i === -1 ? null : execPath.slice(0, i)
}

/** A DMG or translocated bundle cannot self-update. */
function isMacBundleSelfUpdatable(bundle) {
  if (!bundle) return false
  const value = String(bundle)
  return !value.startsWith('/Volumes/') && !value.includes('/AppTranslocation/')
}

function manualDownloadUrl(platform, arch, releaseFlavor = 'standard') {
  const base = 'https://freebuff.com/api/desktop/download'
  if (platform === 'darwin') return `${base}/${arch === 'arm64' ? 'mac-arm64' : 'mac-intel'}`
  if (platform === 'win32')
    return `${base}/${releaseFlavor === 'baseline' ? 'windows-baseline' : 'windows'}`
  if (platform === 'linux') return `${base}/linux`
  return 'https://freebuff.com/desktop'
}

function loadState(app, fs, path) {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'update-state.json'), 'utf8'))
  } catch {
    return {}
  }
}

function saveState(app, fs, path, state) {
  try {
    fs.writeFileSync(path.join(app.getPath('userData'), 'update-state.json'), JSON.stringify(state))
  } catch {
    // Best effort: a failed write only means the user may be prompted again.
  }
}

function init({ currentVersion, isPackaged, releaseFlavor = 'standard', getWindow }) {
  if (singleton) return singleton

  const path = require('node:path')
  const fs = require('node:fs')
  const { app, dialog, shell } = require('electron')
  const autoUpdater = require(
    isPackaged ? path.join(process.resourcesPath, 'electron-updater.cjs') : 'electron-updater',
  ).autoUpdater

  const downloadUrl = manualDownloadUrl(process.platform, process.arch, releaseFlavor)
  let installing = false
  let checking = false

  // Prompt before downloading, then explicitly install after download. This
  // prevents a normal app quit from applying an update the user deferred.
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.autoRunAppAfterInstall = true
  autoUpdater.disableWebInstaller = true
  autoUpdater.logger = {
    debug: (...args) => console.debug('[updater]', ...args),
    info: (...args) => console.info('[updater]', ...args),
    warn: (...args) => console.warn('[updater]', ...args),
    error: (...args) => console.error('[updater]', ...args),
  }
  const dialogParent = () => getWindow() ?? undefined

  function setProgress(fraction) {
    try {
      getWindow()?.setProgressBar(fraction)
    } catch {
      // The window may have closed during installation.
    }
  }

  async function offerManualInstall(error) {
    const { response } = await dialog.showMessageBox(dialogParent(), {
      type: 'error',
      message: 'Update failed to install',
      detail: `${error?.message || error}\n\nYou can download it manually instead.`,
      buttons: ['Download in Browser', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) await shell.openExternal(downloadUrl)
  }

  async function runInstall() {
    if (installing) return
    installing = true

    if (process.platform === 'darwin' && !isMacBundleSelfUpdatable(macAppBundlePath(process.execPath))) {
      try {
        const { response } = await dialog.showMessageBox(dialogParent(), {
          type: 'info',
          message: 'Move Freebuff to Applications to finish updating',
          detail:
            'Freebuff is running from a disk image or temporary location. Download the installer, drag Freebuff into Applications, and launch it there.',
          buttons: ['Download Installer', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
        })
        if (response === 0) await shell.openExternal(downloadUrl)
      } finally {
        installing = false
      }
      return
    }

    const onProgress = ({ percent }) => {
      setProgress(Number.isFinite(percent) ? percent / 100 : 0)
    }
    autoUpdater.on('download-progress', onProgress)

    try {
      await autoUpdater.downloadUpdate()
      setProgress(-1)
      // macOS hands the verified ZIP to Squirrel after downloadUpdate resolves;
      // failures in that final native handoff arrive as an event, not a rejected
      // promise, so keep the manual fallback available until the app exits.
      const onInstallError = (error) => {
        installing = false
        void offerManualInstall(error).catch((e) =>
          console.error('[updater] manual fallback failed:', e?.message || e),
        )
      }
      autoUpdater.once('error', onInstallError)
      try {
        autoUpdater.quitAndInstall(false, true)
      } catch (error) {
        autoUpdater.off('error', onInstallError)
        throw error
      }
    } catch (error) {
      setProgress(-1)
      installing = false
      await offerManualInstall(error)
    } finally {
      autoUpdater.off('download-progress', onProgress)
    }
  }

  async function checkNow({ interactive = false } = {}) {
    if (installing || checking) return
    if (!isPackaged) {
      if (interactive) {
        await dialog.showMessageBox(dialogParent(), {
          type: 'info',
          message: 'Update checks are unavailable in development',
          detail: 'Install a packaged Freebuff build to test automatic updates.',
          buttons: ['OK'],
        })
      }
      return
    }

    checking = true
    let result
    try {
      result = await autoUpdater.checkForUpdates()
    } catch (error) {
      console.error('[updater] check failed:', error?.message || error)
      if (interactive) {
        await dialog.showMessageBox(dialogParent(), {
          type: 'warning',
          message: 'Could not check for updates',
          detail: 'Please try again later or download from freebuff.com/desktop.',
          buttons: ['OK'],
        })
      }
      return
    } finally {
      checking = false
    }

    if (!result?.isUpdateAvailable) {
      if (interactive) {
        await dialog.showMessageBox(dialogParent(), {
          type: 'info',
          message: "You're up to date",
          detail: `Freebuff ${currentVersion} is the latest version.`,
          buttons: ['OK'],
        })
      }
      return
    }

    const version = result.updateInfo.version
    if (!interactive && loadState(app, fs, path).skippedVersion === version) return

    const { response } = await dialog.showMessageBox(dialogParent(), {
      type: 'info',
      message: `Freebuff ${version} is available`,
      detail: `You're running ${currentVersion}.`,
      buttons: ['Install', 'Skip This Version', 'Remind Me Later'],
      defaultId: 0,
      cancelId: 2,
    })
    if (response === 0) await runInstall()
    else if (response === 1) saveState(app, fs, path, { skippedVersion: version })
  }

  if (isPackaged && !process.env.FREEBUFF_DISABLE_UPDATE_CHECK) {
    setTimeout(() => void checkNow(), FIRST_CHECK_DELAY_MS)
    setInterval(() => void checkNow(), CHECK_INTERVAL_MS).unref?.()
  }

  singleton = { checkNow }
  return singleton
}

module.exports = { init }
