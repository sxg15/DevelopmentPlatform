const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('igpDeploy', {
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  onState: (listener) => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('state-updated', handler);
    return () => ipcRenderer.removeListener('state-updated', handler);
  },
  onJob: (listener) => {
    const handler = (_event, job) => listener(job);
    ipcRenderer.on('job-updated', handler);
    return () => ipcRenderer.removeListener('job-updated', handler);
  },
});
