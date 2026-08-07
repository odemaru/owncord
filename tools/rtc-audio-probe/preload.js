// Мост между страницей зонда и main-процессом. Минимальный: отдать
// результат наружу и показать странице, с какими ключами её запустили.
const { contextBridge, ipcRenderer } = require('electron');

const arg = process.argv.find((a) => a.startsWith('--probe-switches='));
contextBridge.exposeInMainWorld('probeInfo', {
  switches: arg ? arg.slice('--probe-switches='.length) : '(unknown)',
});
contextBridge.exposeInMainWorld('probeDone', (json, text) =>
  ipcRenderer.send('probe:done', json, text),
);
