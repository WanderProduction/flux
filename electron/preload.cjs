const { contextBridge, ipcRenderer } = require('electron')

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
    /**
     * A renderer-usable URL for a file on disk. Lives here, beside the protocol
     * it targets, so the scheme is defined once on the Electron side instead of
     * being spelled out again in the UI.
     */
    assetUrl: (filePath) => `flux-asset://local/?p=${encodeURIComponent(filePath)}`,
  },
  platform: process.platform,
})
