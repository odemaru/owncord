// Main-процесс OwnCord Desktop.
//
// Что делает:
//   1) Открывает BrowserWindow и грузит туда веб-клиент по `serverUrl`
//      из конфига. По логике приложения это полностью тот же клиент,
//      что и в браузере, поэтому вся работа с БД (сообщения, звонки,
//      настройки аккаунта) идёт через те же сетевые запросы и socket.io
//      с сервером — десктоп ничего не дублирует локально.
//   2) Поднимает IPC API для renderer-стороны (preload контролирует
//      белый список через contextBridge).
//   3) Регистрирует глобальные хоткеи (см. shortcuts.js) и пробрасывает
//      их в renderer событием 'shortcut:fired'.
//
// Что НЕ делает:
//   - Не хранит сообщения/настройки чата локально. Это всё в БД сервера.
//   - Не парсит/не патчит DOM клиента. Десктоп — это «нативная обёртка»,
//     никаких хирургических вмешательств в страницу.
//
// Безопасность:
//   - contextIsolation: true, nodeIntegration: false — стандартные best-
//     practices Electron'а. Renderer не получает прямого доступа к Node.
//   - Только preload-bridged IPC: getConfig/setConfig, getShortcuts/
//     setShortcuts, recordShortcut(toggle), onShortcutFired.

const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  Menu,
  Tray,
  session,
  desktopCapturer,
} = require('electron');
const path = require('path');
const config = require('./config');
const shortcuts = require('./shortcuts');
const mouseHook = require('./mouseHook');
const autoUpdater = require('./autoUpdater');
const screenPicker = require('./screenPicker/picker');
const processAudio = require('./processAudio');

// Single-instance lock: при попытке запустить вторую копию приложения
// (через ярлык, autostart, иконку в трее) показываем существующее окно
// вместо порождения нового instance'а. Без этого у юзера было бы два окна
// OwnCord, две tray-иконки и два mainProcess'а с конфликтом за audio /
// configFile.
//
// Lock запрашивается ДО app.whenReady() — иначе вторая копия успеет
// поднять свой Electron-runtime и потратить пару секунд впустую.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

// --- Tray + lifecycle state ----------------------------------------
//
// tray         — глобальный singleton иконки в трее. Создаётся ОДИН раз
//                в whenReady, переживает hide/show окна.
// isQuitting   — флаг, который сигнализирует close-handler'у окна, что
//                это «настоящий» quit (через tray-меню / autoUpdater /
//                Cmd+Q), и hide() делать не надо.
// startHidden  — приложение запущено с --hidden (autostart при логине в
//                Windows). Окно создаётся скрытым, юзер видит только
//                tray-иконку.
let tray = null;
let isQuitting = false;
const startHidden = process.argv.includes('--hidden');

// Закрепляем имя приложения ДО любых обращений к app.getPath('userData').
// Иначе в dev (`electron .` из desktop/) Electron берёт name из package.json
// — там `@owncord/desktop` — и кладёт пользовательские данные в
// `%APPDATA%\@owncord\desktop`, а в собранном NSIS-приложении —
// в `%APPDATA%\OwnCord` (productName из electron-builder). Из-за
// разных userData renderer'у достаются РАЗНЫЕ localStorage между
// dev и прод-сборкой, и юзер видит «разлогин на каждом запуске».
// setName('OwnCord') синхронизирует обе ветки.
app.setName('OwnCord');

// Dev-режим (`electron .` без packaging) кладём в отдельный профиль
// `OwnCord-dev`, чтобы:
//   1) если у юзера в фоне крутится установленный prod-OwnCord, его
//      Cache/Cookies не были залочены под нашим chromium'ом (иначе в
//      логе будет "Unable to move the cache: Отказано в доступе" и
//      "Gpu Cache Creation failed", как сейчас);
//   2) prod-сессия (логин, конфиг сервера) не путалась с dev-сессией;
//   3) при тестах не пришлось бы каждый раз правой рукой удалять
//      файлы профиля.
if (!app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'OwnCord-dev'));
}

// Путь к иконке окна. На Windows electron-builder подставляет .ico из
// сборки автоматически, но для dev-режима указываем вручную, иначе в
// taskbar светится иконка Electron'а.
const WINDOW_ICON = path.join(__dirname, 'assets', 'icon.png');

let mainWindow = null;
let cfg = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0b0d10',
    autoHideMenuBar: true,
    title: 'OwnCord',
    icon: WINDOW_ICON,
    // Полностью кастомный титлбар: убираем нативный системный фрейм
    // (на Windows это и заголовок, и кнопки управления). Клиент рисует
    // свой бар на 32px сверху (см. client/src/components/TitleBar.tsx),
    // получая нативные действия через IPC 'window:minimize|maximize|close'.
    // На macOS оставляем дефолт — frame:false без titleBarStyle делает окно
    // без traffic light, что нежелательно: пользователи macOS ждут
    // штатные «светофоры». Поэтому на дарвине ставим titleBarStyle:'hidden',
    // оставляющий native traffic lights поверх нашего бара.
    frame: process.platform !== 'darwin' ? false : undefined,
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : undefined,
    // При autostart с --hidden окно создаётся скрытым (работает в трее).
    // Юзер раскрывает его кликом по tray-иконке.
    show: !startHidden,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Разрешаем WebRTC + getUserMedia без отдельных пермишенов:
      // системный браузер сам выкатит OS-popup для микрофона.
      sandbox: false,
      // КРИТИЧНО для голосовых звонков: по дефолту Electron (=Chromium)
      // троттлит фоновые/скрытые/неактивные окна — таймеры замедляются
      // в десятки раз, requestAnimationFrame замораживается, AudioContext
      // в фоне останавливается. В мессенджере это значит:
      //   • свернул окно → AudioWorklet (RNNoise/voice activity)
      //     перестаёт молоть → mic-track в WebRTC шлёт тишину;
      //   • переключился на другое окно → то же самое.
      // backgroundThrottling: false полностью отключает эту экономию,
      // и звонок продолжает работать так же, как при активном окне.
      // Цена — небольшое CPU-использование в фоне. Для голосового чата
      // это безусловно правильный trade-off.
      backgroundThrottling: false,
    },
  });

  // Внешние ссылки уводим в системный браузер — чтобы пользователь не
  // случайно «застрял» в десктопе на http://google.com и т.п.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {
        /* ignore */
      });
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Скрываем стандартное меню (File/Edit/...) — у нас своё UI.
  Menu.setApplicationMenu(null);

  // DevTools и reload-хоткеи: F12 / Ctrl+Shift+I открывают консоль,
  // Ctrl+R / F5 — обычный reload, Ctrl+Shift+R — hard reload с очисткой кеша.
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const isF12 = input.key === 'F12';
    const isCtrlShiftI = ctrl && input.shift && (input.key === 'I' || input.key === 'i');
    if (isF12 || isCtrlShiftI) {
      mainWindow.webContents.toggleDevTools();
      return;
    }
    const isF5 = input.key === 'F5';
    const isCtrlR = ctrl && !input.shift && (input.key === 'R' || input.key === 'r');
    const isCtrlShiftR = ctrl && input.shift && (input.key === 'R' || input.key === 'r');
    if (isCtrlShiftR) {
      // Hard reload: чистим HTTP-кеш сессии и грузим страницу заново.
      mainWindow.webContents.session.clearCache().finally(() => {
        mainWindow.webContents.reloadIgnoringCache();
      });
      return;
    }
    if (isF5 || isCtrlR) {
      mainWindow.webContents.reload();
    }
  });

  loadServerUrl();

  // Перерегистрируем shortcut'ы после готовности окна — иначе webContents
  // может оказаться не готов к send(). Регистрируем И клавиатурные
  // (через Electron globalShortcut), И мышиные (через uiohook-napi) —
  // оба модуля сами фильтруют свой тип acc'а из общей карты.
  mainWindow.webContents.once('did-finish-load', () => {
    if (cfg.hotkeysEnabled) {
      shortcuts.register(cfg.shortcuts || {}, mainWindow);
      mouseHook.register(cfg.shortcuts || {}, mainWindow);
    }
    // Автообновление: настраиваем после готовности webContents,
    // чтобы первые события (checking/available) долетели до renderer'а.
    // В dev (app.isPackaged === false) сам модуль no-op'ит.
    autoUpdater.setup(mainWindow, { app, ipcMain });
  });

  // Close-handler с поддержкой tray-mode (как у Discord/Telegram):
  // по дефолту крестик ПРЯЧЕТ окно в трей вместо завершения приложения.
  // Это критично для голосового мессенджера — звонки/уведомления
  // продолжают работать даже когда юзер «закрыл» окно. Реальный quit
  // идёт только через tray-меню «Выход» или autoUpdater (которые
  // ставят isQuitting=true перед app.quit()).
  //
  // closeToTray=false в config (юзер сам отключил в настройках) →
  // стандартное поведение, окно реально закрывается.
  mainWindow.on('close', (e) => {
    if (!isQuitting && cfg?.closeToTray !== false) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    // Окно закрылось — обязательно тушим per-process audio child .exe,
    // иначе он висит как orphan-процесс с открытым WASAPI клиентом.
    processAudio.capture.stop().catch(() => {
      /* ignore */
    });
    mainWindow = null;
  });

  // События maximize/unmaximize нужны кастомному титлбару, чтобы
  // переключить иконку «развернуть»↔«восстановить». Без этого пользователь,
  // двойным кликом по бару (или Win+Up) развернувший окно, увидит ту же
  // иконку «развернуть», и кнопка перестанет соответствовать действию.
  const sendMaxState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    try {
      mainWindow.webContents.send('window:state', { maximized: mainWindow.isMaximized() });
    } catch {
      /* renderer мог ещё не подняться — на did-finish-load догоним */
    }
  };
  mainWindow.on('maximize', sendMaxState);
  mainWindow.on('unmaximize', sendMaxState);
  // На enter-full-screen и leave-full-screen (macOS / F11) тоже шлём,
  // чтобы UI знал, что окно сейчас «во весь экран». Это нужно потому
  // что в fullscreen наш кастомный титлбар скрывать необязательно, но
  // иконка должна корректно отражать состояние.
  mainWindow.on('enter-full-screen', sendMaxState);
  mainWindow.on('leave-full-screen', sendMaxState);
}

// --- Tray + window helpers -----------------------------------------

// Показать главное окно (из трея или second-instance). Если окна нет
// (юзер сделал quit, но tray ещё жив? — на самом деле невозможно у нас,
// но на всякий случай) — пересоздаём.
function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Истинный выход: ставим флаг и просим Electron завершиться. Нужен,
// чтобы close-handler понял, что hide() делать не надо.
function quitApp() {
  isQuitting = true;
  app.quit();
}

// Создание трея. Идемпотентно — повторный вызов не даёт второй иконки.
function createTray() {
  if (tray) return tray;
  try {
    tray = new Tray(WINDOW_ICON);
  } catch (e) {
    // На некоторых сборках Linux без штатной системы трея (gnome без
    // расширения) Tray бросает. Это не фатально — приложение может
    // работать без трея, просто крестик будет выходить из приложения.
    console.warn('Tray creation failed:', e);
    return null;
  }
  tray.setToolTip('OwnCord');
  const menu = Menu.buildFromTemplate([
    { label: 'Открыть OwnCord', click: () => showWindow() },
    { type: 'separator' },
    { label: 'Выход', click: () => quitApp() },
  ]);
  tray.setContextMenu(menu);
  // Один клик — показать окно (Windows-конвенция). Double-click — то же,
  // на случай если у юзера single-click не сработал из-за DPI/ускорения.
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
  return tray;
}

// Применить состояние autostart-флага к ОС. На Windows это запись в
// HKCU\Software\Microsoft\Windows\CurrentVersion\Run (Electron делает
// сам через setLoginItemSettings). Передаём args:['--hidden'], чтобы
// при логине OwnCord запускался сразу свернутым в трей.
//
// На macOS требуется code-signed app, на Linux — поддержка systemd user
// units / .desktop autostart. В dev-режиме пропускаем (нет смысла
// прописывать в autostart `electron .` из репозитория).
function applyAutostart(enabled) {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      args: enabled ? ['--hidden'] : [],
    });
  } catch (e) {
    console.warn('setLoginItemSettings failed:', e);
  }
}

function loadServerUrl() {
  const url = (cfg?.serverUrl || '').trim();
  if (!url) {
    // Пустой URL — рисуем встроенную страницу-настройщик. Простой HTML
    // прямо здесь, чтобы не тащить отдельный билд под него. После того
    // как юзер нажмёт «Сохранить», main процесс перезагрузит окно.
    const html = setupHtml();
    mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    return;
  }
  mainWindow.loadURL(url).catch((e) => {
    console.error('Failed to load', url, e);
    // Падение загрузки — показываем тот же экран настроек, чтобы юзер
    // мог исправить URL без удаления конфига руками.
    mainWindow.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(setupHtml(`Не удалось открыть ${url}: ${e?.message || e}`))}`,
    );
  });
}

function setupHtml(error) {
  // Inline-стиль и скрипт. Связь с main через window.electronAPI (preload).
  const errBlock = error
    ? `<div style="background:#3a1212;color:#ffb4b4;padding:10px 14px;border-radius:8px;margin-bottom:12px;">${escapeHtml(error)}</div>`
    : '';
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>OwnCord — настройка</title>
<style>
  body{margin:0;background:#0b0d10;color:#e2e8f0;font-family:system-ui,Segoe UI,Helvetica,Arial,sans-serif;display:grid;place-items:center;min-height:100vh}
  .card{background:#13171c;border:1px solid #232830;border-radius:12px;padding:24px 28px;width:min(420px,90vw)}
  h1{font-size:18px;margin:0 0 14px}
  label{display:block;font-size:12px;color:#94a3b8;margin-bottom:6px}
  input{width:100%;box-sizing:border-box;padding:10px 12px;background:#0b0d10;border:1px solid #232830;border-radius:8px;color:#e2e8f0;font-size:14px}
  button{margin-top:14px;width:100%;padding:10px 12px;background:#1f6feb;border:0;border-radius:8px;color:white;font-weight:600;cursor:pointer}
  button:hover{background:#3a85ff}
  small{display:block;color:#64748b;font-size:11px;margin-top:8px}
</style>
</head><body>
<div class="card">
  <h1>Адрес сервера OwnCord</h1>
  ${errBlock}
  <label>URL (например, https://owncord.example.com)</label>
  <input id="url" placeholder="http://localhost:3000" />
  <button id="save">Сохранить и подключиться</button>
  <small>Этот адрес можно изменить позже в настройках приложения. Конфиг хранится в папке профиля пользователя.</small>
</div>
<script>
  const input = document.getElementById('url');
  const btn = document.getElementById('save');
  // electronAPI здесь доступен потому, что preload подключается ВСЕГДА —
  // даже для inline data:URL, который мы открыли через loadURL.
  window.electronAPI?.getConfig?.().then((c) => { input.value = c?.serverUrl || ''; });
  btn.addEventListener('click', async () => {
    const url = input.value.trim();
    if (!url) return;
    await window.electronAPI?.setConfig?.({ serverUrl: url });
    location.reload(); // main перехватит next-load и грузит уже сервер
  });
</script>
</body></html>`;
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// --- IPC ---------------------------------------------------------

ipcMain.handle('config:get', () => cfg);

ipcMain.handle('config:set', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return cfg;
  cfg = { ...cfg, ...patch, shortcuts: { ...(cfg?.shortcuts || {}), ...(patch.shortcuts || {}) } };
  config.save(cfg);
  // serverUrl изменился — перезагрузим окно.
  if ('serverUrl' in patch && mainWindow) {
    setTimeout(() => loadServerUrl(), 50);
  }
  // autoStart изменился — синкаем с ОС-уровнем (login items / Run-key).
  if ('autoStart' in patch) {
    applyAutostart(cfg.autoStart);
  }
  // shortcuts изменились — перерегистрируем оба слоя (клавиатурный
  // globalShortcut и мышиный uIOhook). Каждый сам отфильтрует свой тип.
  if ('shortcuts' in patch || 'hotkeysEnabled' in patch) {
    if (cfg.hotkeysEnabled) {
      shortcuts.register(cfg.shortcuts || {}, mainWindow);
      mouseHook.register(cfg.shortcuts || {}, mainWindow);
    } else {
      shortcuts.unregisterAll();
      mouseHook.unregisterAll();
    }
  }
  return cfg;
});

ipcMain.handle('shortcuts:set', (_e, map) => {
  cfg.shortcuts = { ...(cfg.shortcuts || {}), ...(map || {}) };
  config.save(cfg);
  if (cfg.hotkeysEnabled && mainWindow) {
    // Сначала клавиатура (быстрее регится), потом мышь (запускает
    // фоновый поток uIOhook при необходимости). Возвращаем объединённый
    // список реально зарегистрированных acc'ов — UI это игнорирует, но
    // полезно для отладки.
    const kb = shortcuts.register(cfg.shortcuts, mainWindow);
    const mouse = mouseHook.register(cfg.shortcuts, mainWindow);
    return [...kb, ...mouse];
  }
  return [];
});

ipcMain.handle('shortcuts:get', () => cfg?.shortcuts || {});

// Версия приложения. Источник правды — app.getVersion(), который читает
// version из desktop/package.json при запаковке. Renderer показывает её
// в сайдбаре настроек, чтобы пользователь видел, какой билд у него стоит
// (особенно полезно при автообновлениях).
ipcMain.handle('app:version', () => app.getVersion());

// --- Кастомный титлбар: управление окном ----------------------------
//
// Renderer рисует свои кнопки min/max/close (см. TitleBar.tsx), а
// действия делегирует сюда через IPC. Без этого, при frame:false,
// у юзера не будет никакого способа закрыть/свернуть/развернуть окно.
//
// window:close уважает closeToTray-настройку (если включена, окно
// прячется в трей вместо реального quit'а — точно так же, как при
// нажатии нативного «крестика» был бы close-handler в createWindow).
// 'window:state' — события для UI: при resize/maximize renderer должен
// перерисовывать иконку «развернуть»/«восстановить».
ipcMain.handle('window:minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});

ipcMain.handle('window:toggle-maximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow.maximize();
  }
});

ipcMain.handle('window:close', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Просто триггерим обычный close — в createWindow стоит handler,
  // который при closeToTray=true спрячет окно, иначе app.quit().
  mainWindow.close();
});

// Renderer вызывает на mount, чтобы синкнуть начальное состояние
// иконки maximize/restore (без события).
ipcMain.handle('window:is-maximized', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return mainWindow.isMaximized();
});

// --- Lifecycle ---------------------------------------------------

app.whenReady().then(() => {
  cfg = config.load();
  createWindow();
  registerDisplayMediaHandler();
  createTray();
  // Синкаем autostart с тем, что юзер сохранил в конфиге. Если
  // приложение собрано в новой версии и закрытие через тимблер раньше
  // отрабатывало некорректно, этот вызов поправит ОС-настройку.
  applyAutostart(cfg.autoStart);

  // Вторая копия приложения (через ярлык / autostart / повторный клик
  // по tray-иконке существующего instance'а) — показываем уже-открытое
  // окно вместо порождения нового runtime'а. См. requestSingleInstanceLock.
  app.on('second-instance', () => {
    showWindow();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// before-quit срабатывает при app.quit() из любой точки (tray-меню,
// autoUpdater.quitAndInstall, Cmd+Q на macOS, etc.). Переводим
// close-handler окна в режим «реальный exit» — иначе он спрячет окно
// и quit зависнет на open-windows-pending.
app.on('before-quit', () => {
  isQuitting = true;
});

// Перехват navigator.mediaDevices.getDisplayMedia() из renderer'а.
//
// Без этого хендлера в Electron 23+ getDisplayMedia() сразу отклоняется
// (или висит в Pending без UI) — Electron не показывает chromium'овский
// системный picker, потому что он завязан на десктопного пользователя
// chromium-shell'а, которого у нас нет. Решение — свой picker через
// desktopCapturer.getSources, что мы и делаем в screenPicker/picker.js.
//
// Аудио-логика:
//   - Renderer всегда вызывает getDisplayMedia с audio: <constraints>.
//     Electron ТРЕБУЕТ, чтобы при request.audioRequested === true callback
//     предоставил audio (либо 'loopback', либо MediaStreamTrack/Stream).
//     Если вернуть audio: undefined при audio:true — chromium reject'ит
//     promise, и юзер видит «не удалось начать демонстрацию». Поэтому:
//
//   - Шарим ЭКРАН + звук → audio: 'loopback' (системный микшер всех
//     приложений; иначе быть не может — в одном экране много окон).
//   - Шарим ОКНО + звук → audio: 'loopback' ВСЁ ЖЕ возвращаем (иначе
//     chromium падает), но ПАРАЛЛЕЛЬНО запускаем WASAPI process-loopback
//     по PID окна (processAudio.js). Renderer после getDisplayMedia
//     спрашивает у main `proc-audio:is-active` — если true, удаляет
//     chromium audio track из стрима и заменяет его на наш PCM-track.
//     В итоге слышен ровно звук целевого приложения.
//   - macOS / Linux без поддержки → audio: 'loopback' (на Windows) или
//     undefined (на macOS, Chromium не поддерживает). Юзер видит toast,
//     если в picker'е стояло «без звука» — звука не будет.
//
// Тонкости:
//   - callback({}) = отказ (юзер закрыл picker / нет источников).
//   - useSystemPicker: false — нативный (chromium) picker в Electron
//     помечен как experimental и часто пуст, остаёмся на своём.
function registerDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
        const choice = await screenPicker.pickScreenSource(parent, {
          wantsAudio: !!request.audioRequested,
          platform: process.platform,
        });

        // Юзер закрыл picker / выбрал «Отмена» / parent умер.
        if (!choice || !choice.id) {
          callback({});
          return;
        }

        // Перед стартом нового шеринга всегда стопаем предыдущий
        // process-loopback: юзер может закончить один шер и начать
        // другой без явного «остановить» (re-share). Если этого не
        // сделать, активный child .exe останется висеть.
        await processAudio.capture.stop();

        // Берём свежий source с того же id — между списком в picker'е и
        // моментом callback'а окно могло, например, свернуться: thumbnail
        // больше не нужен, нам нужен только sourceId для chromium'а.
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 1, height: 1 },
        });
        const source = sources.find((s) => s.id === choice.id);
        if (!source) {
          // Окно/экран могли закрыться, пока юзер выбирал — отдаём
          // пустой стрим, клиент покажет toast «не удалось начать».
          callback({});
          return;
        }

        // Audio-mode для callback'а. Главное правило: если renderer просил
        // audio (request.audioRequested === true), мы ОБЯЗАНЫ что-то отдать,
        // иначе chromium reject'ит весь getDisplayMedia.
        //
        // На non-darwin ОС у Electron'а есть 'loopback' (системный микшер).
        // На macOS его нет — отдаём undefined, юзер увидит видео без звука.
        let audioMode; // 'loopback' | undefined
        if (choice.audio || request.audioRequested) {
          audioMode = process.platform !== 'darwin' ? 'loopback' : undefined;
        }

        // Параллельно: для шеринга ОКНА с галкой звука пытаемся запустить
        // per-process WASAPI loopback. Если получилось — renderer сам
        // удалит chromium-audio (системный микшер) и заменит на наш PCM,
        // спросив у main proc-audio:is-active. Если не получилось (окно
        // закрылось, ОС не Windows и т.п.) — останется chromium-loopback.
        if (choice.audio && choice.kind === 'window' && processAudio.capture.isSupported()) {
          const pid = await processAudio.capture.findPidByHwnd(choice.hwnd);
          if (pid) {
            await processAudio.capture.start(pid);
          }
        }

        callback({ video: source, audio: audioMode });
      } catch (err) {
        console.error('display media handler failed:', err);
        try {
          await processAudio.capture.stop();
        } catch {
          /* ignore */
        }
        callback({});
      }
    },
    { useSystemPicker: false },
  );
}

// --- Process-audio IPC + жизненный цикл --------------------------------

// При каждом chunk'е PCM из ApplicationLoopback.exe пушим его в renderer.
// Window'у достаточно одного активного — у нас в звонке всегда один
// шеринг. Если mainWindow умер (refresh, F5), .send() выкинет ошибку —
// глушим, на следующий раз renderer пере-подпишется.
processAudio.capture.on('chunk', (data) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('proc-audio:chunk', data);
  } catch {
    /* окно закрылось между chunk-ами */
  }
});

processAudio.capture.on('ended', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('proc-audio:ended');
  } catch {
    /* ignore */
  }
});

// IPC: renderer спрашивает формат PCM — обычно сразу после старта стрима,
// чтобы создать AudioContext с правильным sampleRate.
ipcMain.handle('proc-audio:get-format', () => processAudio.capture.getFormat());

// IPC: поддерживается ли per-process loopback. UI ScreenQualityModal
// может это использовать, чтобы по-разному подписать чекбокс «звук».
ipcMain.handle('proc-audio:is-supported', () => processAudio.capture.isSupported());

// IPC: сейчас main активно стримит PCM? Renderer спрашивает сразу после
// getDisplayMedia, чтобы решить: оставить chromium audio track (system
// loopback / весь микшер) или удалить и заменить на наш per-process PCM.
ipcMain.handle('proc-audio:is-active', () => processAudio.capture.isActive());

// IPC: renderer останавливает screen-share и просит остановить захват.
// Например, когда юзер нажал «прекратить демонстрацию» в звонке.
ipcMain.handle('proc-audio:stop', async () => {
  await processAudio.capture.stop();
  return true;
});

// --- Run-as-admin (Windows) --------------------------------------------
//
// Перезапуск приложения с правами администратора. Нужно для:
//   - игр и античитов (Battleye/EAC/Vanguard), которые работают в
//     elevated-режиме и блокируют хоткеи от non-elevated процессов;
//   - правки HKLM ветки реестра (например, через сторонние утилиты,
//     которые OwnCord может запускать) — но это редкий кейс.
//
// Без сторонних библиотек elevation делаем стандартным Windows-способом:
// `ShellExecute` с verb 'runas'. Из Node.js удобнее всего через
// PowerShell: `Start-Process -Verb RunAs`. UAC-prompt покажется юзеру
// автоматически. Если он откажется — новая копия НЕ запустится, и
// старая (текущий instance) останется работать; мы это узнаём по
// отсутствию сигнала и просто не делаем quit (см. таймаут в catch).
//
// process.execPath = полный путь до OwnCord.exe в установленной папке
// (например, C:\Users\Username\AppData\Local\Programs\OwnCord\OwnCord.exe).
// В dev режиме это будет путь до electron.exe, что для elevated-перезапуска
// нет смысла — отдаём ошибку.
ipcMain.handle('app:relaunch-as-admin', async () => {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Доступно только на Windows' };
  }
  if (!app.isPackaged) {
    return { ok: false, error: 'Только для установленной версии (не dev)' };
  }
  try {
    const { spawn } = require('node:child_process');
    const exe = process.execPath;
    // Одинарные кавычки в пути экранируем как '' для PowerShell-литерала.
    const escaped = exe.replace(/'/g, "''");
    // -NoProfile: не подгружаем профиль юзера (быстрее старт PowerShell).
    // -WindowStyle Hidden: окно PowerShell не светится (короткое, всё равно).
    // Start-Process -Verb RunAs: показывает UAC-prompt и стартует процесс
    //   с elevation, если юзер согласился.
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-WindowStyle',
        'Hidden',
        '-Command',
        `Start-Process -FilePath '${escaped}' -Verb RunAs`,
      ],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    // Не делаем app.quit() мгновенно: если юзер откажется от UAC-prompt'а,
    // нам нужно остаться работать. Но и долго ждать тоже нельзя — UAC
    // window сам по себе блокирует UI до решения юзера. Дадим 800 мс
    // на запуск нового процесса (включая UAC-flicker), после чего тушим
    // текущий instance. Если новая копия НЕ запустится из-за отказа от
    // UAC — пользователь увидит, что приложение просто закрылось.
    // (TODO: можно подписаться на child.on('exit'), но при detached оно
    //  не репортит exit нашего нового elevated-процесса — это уже не
    //  наш subprocess. Ограничимся timeout-ом.)
    setTimeout(() => {
      isQuitting = true;
      app.quit();
    }, 800);
    return { ok: true };
  } catch (e) {
    console.error('relaunch as admin failed:', e);
    return { ok: false, error: e?.message || String(e) };
  }
});

app.on('window-all-closed', () => {
  // С tray-mode (closeToTray=true по дефолту) обычный close прячет окно,
  // а не закрывает его — getAllWindows().length остаётся 1, и сюда мы
  // НЕ попадаем. Сюда попадаем только если: юзер отключил closeToTray
  // в настройках, либо окно убито внешне (alt+f4 + handler не сработал,
  // crash и т.п.). В таких случаях честно гасим хоткеи и выходим.
  //
  // На macOS конвенция «закрыл единственное окно — приложение живёт в
  // dock'е». Не выходим.
  shortcuts.unregisterAll();
  mouseHook.unregisterAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  shortcuts.unregisterAll();
  mouseHook.unregisterAll();
  // Завершаем per-process audio capture (если активен) синхронно,
  // чтобы child .exe не пережил наш main-процесс.
  processAudio.capture.stop().catch(() => {
    /* ignore */
  });
});
