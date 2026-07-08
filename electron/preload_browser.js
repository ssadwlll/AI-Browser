const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('browserAPI', {
  onContextMenu: (callback) => {
    const handler = (e, data) => callback(data)
    ipcRenderer.on('browser:context-menu', handler)
    return () => ipcRenderer.removeListener('browser:context-menu', handler)
  },
  // 划词工具栏：发送选中文本和操作类型到主进程
  selectionAction: (action, text) => ipcRenderer.send('browser:selection-action', { action, text }),
  // 划词工具栏：获取是否启用
  getSelectionToolsEnabled: () => ipcRenderer.invoke('browser:get-selection-tools'),
})
