// Зонд аудио-тракта OwnCord Desktop.
//
// Зачем: в десктоп-сборке отключён микрофонный пайплайн, а вместе с ним и
// AI-шумодав — автор столкнулся с тем, что собеседник слышит тишину, и
// объяснил это тем, что Electron кодирует трек от MediaStreamDestination
// в тишину (см. коммит v0.8.9). На macOS/Electron 42 это утверждение
// воспроизвести НЕ удалось: звук проходит. Значит проблема либо
// платформенная (Windows/WASAPI против macOS/CoreAudio), либо связана с
// микрофоном как источником, а не с Web Audio вообще.
//
// Этот зонд отвечает на вопрос фактами. Он поднимает петлю
// RTCPeerConnection внутри одного окна и меряет реально принятый звук
// анализатором, а не метрикой inbound-rtp.audioLevel — та равна нулю при
// приглушённом приёмнике и легко приводит к ложному диагнозу.
//
// Запуск: npm install && npm start
// Варианты с ключами Chromium — см. npm run в package.json.

const { app, BrowserWindow, ipcMain, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');

// Ключи Chromium приходят через SWITCHES, элементы разделяются '~~'.
// Именно '~~', а не ';;': точка с запятой — разделитель команд в оболочке,
// и npm-скрипт с ней разваливается и в cmd.exe, и в sh.
// Пример: "disable-features=AudioServiceOutOfProcess~~autoplay-policy=no-user-gesture-required"
const raw = (process.env.SWITCHES || '').trim();
const applied = [];
for (const item of raw ? raw.split('~~') : []) {
  const s = item.trim();
  if (!s) continue;
  const eq = s.indexOf('=');
  if (eq === -1) {
    app.commandLine.appendSwitch(s);
    applied.push(s);
  } else {
    app.commandLine.appendSwitch(s.slice(0, eq), s.slice(eq + 1));
    applied.push(s);
  }
}
const switchesLabel = applied.length ? applied.join(' ') : '(без ключей — базовый прогон)';
console.log('[probe] ключи:', switchesLabel);

let finished = false;

app.whenReady().then(async () => {
  // macOS требует явного разрешения на микрофон. На Windows этого шага нет.
  if (process.platform === 'darwin') {
    const st = systemPreferences.getMediaAccessStatus('microphone');
    console.log('[probe] доступ к микрофону:', st);
    if (st !== 'granted') {
      try {
        console.log('[probe] запрос доступа ->', await systemPreferences.askForMediaAccess('microphone'));
      } catch (e) {
        console.log('[probe] запрос упал:', e && e.message);
      }
    }
  }

  const win = new BrowserWindow({
    width: 820,
    height: 620,
    title: 'OwnCord — диагностика аудио',
    backgroundColor: '#0b0d10',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Как в реальной десктоп-сборке OwnCord, иначе замеры не показательны.
      backgroundThrottling: false,
      additionalArguments: ['--probe-switches=' + switchesLabel],
    },
  });

  // Renderer-консоль в Electron не попадает в stdout — пробрасываем сами,
  // чтобы результат был виден и в терминале, и в окне.
  // В Electron 40+ у события один аргумент-объект; в старых — россыпь
  // позиционных. Поддерживаем оба, чтобы зонд работал и на другой версии.
  win.webContents.on('console-message', (...args) => {
    const message = args[0] && typeof args[0] === 'object' && 'message' in args[0]
      ? args[0].message
      : args[2];
    if (typeof message === 'string' && message.startsWith('[PROBE]')) {
      console.log(message.replace('[PROBE] ', ''));
    }
  });

  // Разрешаем микрофон без лишних вопросов — это локальный диагностический
  // инструмент, и запрос ОС (там, где он есть) юзер уже подтвердил.
  win.webContents.session.setPermissionRequestHandler((_wc, perm, cb) =>
    cb(perm === 'media' || perm === 'microphone'),
  );

  win.loadFile(path.join(__dirname, 'probe.html'));

  ipcMain.on('probe:done', (_e, json, text) => {
    if (finished) return;
    finished = true;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(process.cwd(), `rtc-probe-${stamp}.txt`);
    const body =
      `OwnCord RTC audio probe\n` +
      `дата: ${new Date().toISOString()}\n` +
      `платформа: ${process.platform} ${process.arch}\n` +
      `electron: ${process.versions.electron}  chrome: ${process.versions.chrome}\n` +
      `ключи: ${switchesLabel}\n\n${text}\n\nJSON:\n${json}\n`;
    try {
      fs.writeFileSync(file, body, 'utf8');
      console.log('\n[probe] результат сохранён: ' + file);
    } catch (e) {
      console.log('[probe] не удалось записать файл:', e && e.message);
    }
    console.log('\n[probe] окно закроется через 20 секунд (или закрой сам).');
    setTimeout(() => app.exit(0), 20000);
  });

  // Страховка от зависания.
  setTimeout(() => {
    if (!finished) {
      console.log('[probe] ТАЙМАУТ — тест не завершился');
      app.exit(2);
    }
  }, 180000);
});

app.on('window-all-closed', () => app.quit());
