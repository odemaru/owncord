// Preload: единственный мост между main и renderer'ом.
//
// contextBridge экспонирует ровно тот набор функций, который нужен
// клиенту OwnCord. Любая попытка из renderer'а дотянуться до Node API
// в обход этого моста = отказ; так и должно быть (contextIsolation).
//
// Обработка 'shortcut:fired':
//   Main шлёт IPC при срабатывании глобального хоткея, мы превращаем
//   событие в DOM-event 'owncord:shortcut' с detail.action = 'toggleMute'
//   и т.п. На него подписаны useCall/useGroupCall, которые вызывают
//   соответствующий toggle. Так renderer-код не зависит от Electron'а:
//   на вебе DOM-событие никто не пошлёт — фича просто не работает.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Метка, по которой клиент детектит, что он в десктоп-обёртке.
  isDesktop: true,

  // Платформа Node.js: 'win32' | 'darwin' | 'linux' и т.д. Нужна
  // кастомному титлбару, чтобы знать, на какой стороне рисовать
  // кнопки управления (Windows — справа, macOS — слева).
  platform: process.platform,

  // Версия desktop-приложения (из desktop/package.json через app.getVersion()).
  // Используется в SettingsPanel для отображения "OwnCord X.Y.Z" в сайдбаре.
  // Возвращает Promise<string>.
  getVersion: () => ipcRenderer.invoke('app:version'),

  // --- Кастомный титлбар: управление окном ---
  // frame: false убирает нативные кнопки управления, поэтому renderer
  // рисует свои (см. client/src/components/TitleBar.tsx) и шлёт сюда
  // действия. close-handler в main уважает closeToTray-настройку.
  windowControls: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    // Подписка на 'window:state' — main шлёт при maximize/unmaximize/
    // enter-full-screen/leave-full-screen. handler получает {maximized:bool}.
    // Возвращает unsubscribe.
    onState: (handler) => {
      const listener = (_e, payload) => {
        try {
          handler?.(payload || {});
        } catch (err) {
          console.warn('window:state handler failed:', err);
        }
      };
      ipcRenderer.on('window:state', listener);
      return () => ipcRenderer.removeListener('window:state', listener);
    },
  },

  // Перезапустить приложение с правами администратора (Windows). Покажет
  // UAC-prompt; при согласии запустит новый elevated instance и закроет
  // текущий через ~800 мс. При отказе — текущий instance закрывается,
  // нового нет (так работает Start-Process -Verb RunAs).
  // Возвращает { ok: boolean, error?: string }.
  relaunchAsAdmin: () => ipcRenderer.invoke('app:relaunch-as-admin'),

  // --- Конфиг (server URL, autostart, hotkeysEnabled) ---
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),

  // --- Глобальные хоткеи ---
  // map: { toggleMute: 'CommandOrControl+Shift+M', toggleDeafen: '...' }
  // null/'' в значении = снять хоткей для этого действия.
  setShortcuts: (map) => ipcRenderer.invoke('shortcuts:set', map),
  getShortcuts: () => ipcRenderer.invoke('shortcuts:get'),

  // Подписка на срабатывания хоткеев. Возвращает unsubscribe.
  onShortcut: (handler) => {
    const listener = (_e, payload) => {
      try {
        const action = payload?.action;
        if (!action) return;
        // Проксируем в DOM-событие. detail.action — имя действия
        // ('toggleMute' | 'toggleDeafen' | ...).
        window.dispatchEvent(new CustomEvent('owncord:shortcut', { detail: { action } }));
        if (typeof handler === 'function') handler(action);
      } catch (err) {
        console.warn('shortcut handler failed:', err);
      }
    };
    ipcRenderer.on('shortcut:fired', listener);
    return () => ipcRenderer.removeListener('shortcut:fired', listener);
  },

  // --- Автообновление -------------------------------------------------
  // Подписка на жизненный цикл апдейта. payload.kind:
  //   'checking' | 'available' | 'none' | 'progress' | 'downloaded' | 'error'
  // Возвращает unsubscribe.
  onUpdateEvent: (handler) => {
    const listener = (_e, payload) => {
      try {
        // DOM-событие — для компонентов, которые не могут вызвать preload
        // напрямую (хук в одном месте, listener'ы в другом).
        window.dispatchEvent(new CustomEvent('owncord:update', { detail: payload }));
        if (typeof handler === 'function') handler(payload);
      } catch (err) {
        console.warn('update handler failed:', err);
      }
    };
    ipcRenderer.on('update:event', listener);
    return () => ipcRenderer.removeListener('update:event', listener);
  },

  // Применить скачанный апдейт прямо сейчас. Под капотом
  // autoUpdater.quitAndInstall(silent=true, runAfter=true) — приложение
  // закроется, NSIS бесшумно подменит файлы, новая версия запустится.
  installUpdate: () => ipcRenderer.invoke('update:install'),

  // Ручная проверка обновлений (например, кнопка в настройках).
  // Возвращает { ok: boolean, version?: string, error?: string }.
  checkForUpdates: () => ipcRenderer.invoke('update:check'),

  // Запросить текущее закэшированное состояние auto-update (последний
  // значимый event: 'available' | 'downloaded' | 'error' | 'none').
  // Renderer вызывает на mount, чтобы догнать event'ы, которые могли
  // прилететь до того, как он успел подписаться через onUpdateEvent.
  // Возвращает state | null.
  getUpdateState: () => ipcRenderer.invoke('update:get-state'),

  // --- Per-process audio loopback ------------------------------------
  // Когда юзер шарит ОКНО приложения с галкой «звук», main вместо
  // chromium loopback запускает WASAPI process-loopback и шлёт сюда
  // PCM-чанки. Renderer в media.ts собирает из них MediaStreamTrack и
  // подцепляет к screen-share стриму. См. desktop/processAudio.js.
  procAudio: {
    // Поддерживается ли per-process loopback. Только Windows x64.
    // Используется UI'ем, чтобы решать, что писать в подсказке у
    // чекбокса «передавать звук» в picker'е/настройках.
    isSupported: () => ipcRenderer.invoke('proc-audio:is-supported'),

    // Сейчас идёт активный per-process захват? Renderer спрашивает это
    // сразу после getDisplayMedia: если true → надо удалить chromium
    // audio track (системный микшер) и заменить на наш PCM-track.
    isActive: () => ipcRenderer.invoke('proc-audio:is-active'),

    // { sampleRate, channels, encoding, bytesPerSample } — формат, в
    // котором main отдаёт PCM. Renderer создаёт AudioContext с этим
    // sampleRate, чтобы не было ресэмплинга.
    getFormat: () => ipcRenderer.invoke('proc-audio:get-format'),

    // Подписка на 'proc-audio:chunk'. handler получает Uint8Array с
    // raw PCM. Возвращает unsubscribe-функцию.
    onChunk: (handler) => {
      const listener = (_e, data) => {
        try {
          handler(data);
        } catch (err) {
          console.warn('proc-audio chunk handler failed:', err);
        }
      };
      ipcRenderer.on('proc-audio:chunk', listener);
      return () => ipcRenderer.removeListener('proc-audio:chunk', listener);
    },

    // Подписка на 'proc-audio:ended' — main остановил захват
    // (например, целевое приложение закрылось, или мы сами вызвали
    // stop()). Renderer должен очистить аудио-граф. unsubscribe.
    onEnded: (handler) => {
      const listener = () => {
        try {
          handler();
        } catch (err) {
          console.warn('proc-audio ended handler failed:', err);
        }
      };
      ipcRenderer.on('proc-audio:ended', listener);
      return () => ipcRenderer.removeListener('proc-audio:ended', listener);
    },

    // Попросить main остановить активный захват. Используется, когда
    // renderer завершает screen-share (track.onended / явный «стоп»).
    stop: () => ipcRenderer.invoke('proc-audio:stop'),
  },
});
