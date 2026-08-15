/**
 * Preload for the Freebuff renderer. The renderer is the existing
 * self-contained UI served by the Bun orchestrator and talks to it over local
 * HTTP/SSE, so it needs almost nothing from here. We expose a tiny read-only
 * surface for environment/version display and keep contextIsolation on.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('freebuffDesktop', {
  platform: process.platform,
  // True when this window is frameless and the renderer must draw the
  // minimize/maximize/close buttons. Arrives as an argv flag derived from the
  // frame option this window was built with — a sandboxed preload's require
  // resolves built-ins only, so it cannot ask a shared module.
  customTitleBar: (process.argv || []).includes('--custom-title-bar=1'),
  // Menu → renderer tab commands ('new-tab' | 'reopen-tab' | 'close-tab').
  onMenuCommand: (handler) => {
    const listener = (_event, name) => handler(name)
    ipcRenderer.on('menu-cmd', listener)
    return () => ipcRenderer.removeListener('menu-cmd', listener)
  },
  // Resolve a dropped File to its absolute path. Electron 32+ removed File.path,
  // so the composer's drag-and-drop relies on this. Returns '' for non-file blobs.
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
  // Native open dialog for the paperclip button — files AND folders, multi-select.
  // Resolves to [{ path, name, isDirectory }] (the main process stats each pick).
  pickAttachments: () => ipcRenderer.invoke('dialog:pickAttachments'),
  // Native folder chooser for the project picker. Resolves to the chosen
  // absolute path, or null when the user cancels.
  pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
  // Write pasted image bytes (a screenshot has no path) to a temp file so it can be
  // attached like any other file. Resolves to { path, name } or null on failure.
  saveClipboardImage: (bytes, ext) => ipcRenderer.invoke('clipboard:saveImage', { bytes, ext }),
  // The composer only has a local path before the message is sent. Keep file
  // reads in the main process rather than exposing file:// URLs to the renderer.
  readImage: (filePath) => ipcRenderer.invoke('attachment:readImage', filePath),
  // Bring up the system terminal for recovery flows the app can't drive itself
  // (e.g. re-running `claude /login`). mac-only; resolves false elsewhere.
  openTerminal: () => ipcRenderer.invoke('shell:openTerminal'),
  // Open a web URL in the system browser without relying on Chromium's popup
  // activation window. The main process accepts http(s) URLs only.
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  // Reveal a changed file in Finder/Explorer without exposing a general-purpose
  // shell path opener to the renderer. The main process contains the relative
  // path inside the supplied thread worktree.
  revealChange: (root, relativePath) =>
    ipcRenderer.invoke('shell:revealChange', { root, relativePath }),
  // Current { fullScreen, maximized } — same shape onWindowStateChange pushes,
  // for renderers that subscribe after the initial push (or after a reload).
  windowState: () => ipcRenderer.invoke('window:state'),
  // Frameless-window controls; the resulting state arrives on 'window-state'.
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window:toggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  onWindowStateChange: (handler) => {
    const listener = (_event, state) => handler(state)
    ipcRenderer.on('window-state', listener)
    return () => ipcRenderer.removeListener('window-state', listener)
  },
})
