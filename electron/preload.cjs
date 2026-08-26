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
  platform: process.platform,
})
