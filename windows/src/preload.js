// The offline card's buttons. The hub's panel gets nothing: it runs as it does in a browser.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('houseWindow', {
    retry: () => ipcRenderer.send('house:retry'),
    hide: () => ipcRenderer.send('house:hide'),
    useHub: (url) => ipcRenderer.send('house:use-hub', url),
  });
}
