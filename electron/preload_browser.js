const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('browserAPI', {
  onContextMenu: (callback) => {
    const handler = (e, data) => callback(data)
    ipcRenderer.on('browser:context-menu', handler)
    return () => ipcRenderer.removeListener('browser:context-menu', handler)
  },
})
