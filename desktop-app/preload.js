const { contextBridge } = require('electron');

// Expor APIs seguras para o renderer
contextBridge.exposeInMainWorld('electronAPI', {
  getVersion: () => process.versions.electron,
  getPlatform: () => process.platform,
  getArch: () => process.arch
});
