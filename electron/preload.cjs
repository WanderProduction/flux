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
    scan: (dirPath) => ipcRenderer.invoke('fs:scan', dirPath),
    pickOutputDirectory: () => ipcRenderer.invoke('dialog:pickOutputDirectory'),
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
    /**
     * Sequences are files of their own, in the project's sequences folder. The
     * folder is the list — see electron/project.js.
     */
    listSequences: (root) => ipcRenderer.invoke('project:listSequences', root),
    saveSequence: (root, document, previousFile) =>
      ipcRenderer.invoke('project:saveSequence', root, document, previousFile),
    deleteSequence: (root, file) => ipcRenderer.invoke('project:deleteSequence', root, file),
    readQueue: (root) => ipcRenderer.invoke('project:readQueue', root),
    writeQueue: (root, jobs) => ipcRenderer.invoke('project:writeQueue', root, jobs),
    importSequence: (root, sourcePath) =>
      ipcRenderer.invoke('project:importSequence', root, sourcePath),
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
  /**
   * Rendering. The queue lives in main — see electron/renderQueue.js — so this
   * is a remote control for it rather than a wrapper around a local object.
   *
   * `onEvent` returns its own unsubscribe, because a panel that mounts and
   * unmounts repeatedly would otherwise stack a listener per mount and get the
   * same progress event a dozen times.
   */
  render: {
    tools: () => ipcRenderer.invoke('render:tools'),
    start: (jobs, config) => ipcRenderer.invoke('render:start', jobs, config),
    cancel: () => ipcRenderer.invoke('render:cancel'),
    state: () => ipcRenderer.invoke('render:state'),
    reveal: (dirPath) => ipcRenderer.invoke('render:reveal', dirPath),
    onEvent: (handler) => {
      const listener = (_e, payload) => handler(payload)
      ipcRenderer.on('render:event', listener)
      return () => ipcRenderer.removeListener('render:event', listener)
    },
  },

  /**
   * Updates. Nothing here starts one — see electron/updater.js: the check runs
   * at startup on its own, and this is how the window learns what it found.
   *
   * `state()` as well as `onState`, because the check can finish before a
   * window exists to be told about it, and a renderer that only listened would
   * then never hear that an update is already waiting.
   */
  updates: {
    state: () => ipcRenderer.invoke('update:state'),
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onState: (handler) => {
      const listener = (_e, payload) => handler(payload)
      ipcRenderer.on('update:state', listener)
      return () => ipcRenderer.removeListener('update:state', listener)
    },
  },
  /**
   * The application menu.
   *
   * `describe` is the renderer telling the main process what it has — panels,
   * saved layouts, which workspace is on — because those live here and the menu
   * lives there. `onRun` is the answer coming back: a command id, which the
   * renderer runs through the same table the palette uses.
   */
  menu: {
    describe: (description) => ipcRenderer.send('menu:describe', description),
    onRun: (handler) => {
      const listener = (_e, id) => handler(id)
      ipcRenderer.on('menu:run', listener)
      return () => ipcRenderer.removeListener('menu:run', listener)
    },
  },
  platform: process.platform,
})
