const { contextBridge, ipcRenderer, webUtils } = require('electron')

/**
 * The only bridge between the renderer and the OS.
 * Keep this surface tiny and explicit — everything the app can touch outside
 * the sandbox has to be listed here on purpose.
 */
contextBridge.exposeInMainWorld('flux', {
  store: {
    get: (name) => ipcRenderer.invoke('store:get', name),
    set: (name, value) => ipcRenderer.invoke('store:set', name, value),
  },
  fs: {
    places: () => ipcRenderer.invoke('fs:places'),
    list: (dirPath) => ipcRenderer.invoke('fs:list', dirPath),
    subfolders: (dirPath) => ipcRenderer.invoke('fs:subfolders', dirPath),
    exists: (paths) => ipcRenderer.invoke('fs:exists', paths),
    pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
    pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
    pickProjectFile: () => ipcRenderer.invoke('dialog:pickProjectFile'),
    /**
     * A renderer-usable URL for a file on disk. Lives here, beside the protocol
     * it targets, so the scheme is defined once on the Electron side instead of
     * being spelled out again in the UI.
     */
    assetUrl: (filePath) => `flux-asset://local/?p=${encodeURIComponent(filePath)}`,
    /**
     * The real path behind a File dropped in from Explorer.
     *
     * Electron removed File.path, so this is the only way a drop from outside
     * the app can name what was dropped. It reads a path the user already
     * chose by dragging it - it cannot browse, and it opens nothing.
     */
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    },
  },
  media: {
    /**
     * Which version of a file this is: its size and modification time.
     *
     * Everything the index cache remembers is keyed on this, and it is carried
     * from the lookup through to the write so an index built from one set of
     * bytes can never be stored against another. See electron/mediaCache.js.
     */
    sourceToken: (filePath) => ipcRenderer.invoke('media:sourceToken', filePath),
    /**
     * Derived data, by name: a demuxed sample table, audio peaks, whatever
     * comes next. One envelope and one staleness rule for all of it.
     */
    read: (filePath, name, token) => ipcRenderer.invoke('media:read', filePath, name, token),
    write: (filePath, name, token, bytes) =>
      ipcRenderer.invoke('media:write', filePath, name, token, bytes),
    /** Throws one cached thing away, so it is worked out again next time. */
    forget: (filePath, name) => ipcRenderer.invoke('media:forget', filePath, name),
  },
  project: {
    create: (root, name) => ipcRenderer.invoke('project:create', root, name),
    open: (root) => ipcRenderer.invoke('project:open', root),
    is: (root) => ipcRenderer.invoke('project:is', root),
    copyIntoImports: (root, sourcePath) =>
      ipcRenderer.invoke('project:copyIntoImports', root, sourcePath),
    save: (file, document) => ipcRenderer.invoke('project:save', file, document),
    launchTarget: () => ipcRenderer.invoke('project:launchTarget'),
    /**
     * Whether closing would lose work. Pushed, not asked for: main needs the
     * answer inside a window 'close' handler, where there is no room to wait
     * for a round trip to the renderer.
     */
    setUnsaved: (unsaved) => ipcRenderer.send('project:unsaved', unsaved),
    onSaveAndClose: (handler) => {
      ipcRenderer.on('project:save-and-close', async () => {
        await handler()
        ipcRenderer.send('project:close-confirmed')
      })
    },
    /** A .flux double-clicked while FLUX was already running. */
    onOpenTarget: (handler) => {
      ipcRenderer.on('project:open-target', (_e, file) => handler(file))
    },
  },
  platform: process.platform,
})
