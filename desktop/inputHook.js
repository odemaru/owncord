// Глобальный ПАССИВНЫЙ хук ввода (клавиатура + мышь) через uiohook-napi.
//
// Зачем: Electron globalShortcut НЕ умеет ловить кнопки мыши на уровне
// ОС (его API принимает только клавиатурные acc'ы — см. shortcuts.js).
// Без нативного хука мышиные хоткеи (Mouse4/Mouse5/MouseMiddle) могут
// работать только пока окно OwnCord в фокусе, что бесполезно для
// PTT/мьюта во время игр и других fullscreen-приложений.
//
// uiohook-napi — N-API биндинги к libuiohook (кросс-платформенная
// C-библиотека), которая ставит ОС-уровневые input hooks (Win32
// SetWindowsHookEx, X11 XRecord, Quartz CGEventTap). Поставляется с
// prebuilt-binaries для win32/darwin/linux × x64/arm64, поэтому
// node-gyp/rebuild при сборке НЕ требуется.
//
// Контракт (зеркалит shortcuts.js):
//   register(map, win) — заменяет текущие мышиные bind'ы новой картой.
//     `map`  — { actionName: acceleratorString | null }; не-мышиные
//              acc'ы (без `MouseN`/`MouseMiddle` суффикса) тихо
//              пропускаются. Это позволяет вызывающей стороне отдавать
//              СЫРУЮ карту настроек, не разбирая её на «клавишные» и
//              «мышиные» ветки.
//     `win`  — BrowserWindow для отправки IPC 'shortcut:fired'. Тот же
//              канал, что использует shortcuts.js — renderer не должен
//              различать источник события.
//   unregisterAll() — снимает всё и останавливает фоновый поток uIOhook.
//
// Почему клавиатура тоже здесь, а не в Electron globalShortcut.
//
// globalShortcut ПРОГЛАТЫВАЕТ клавишу на уровне ОС: до приложения, в
// котором ты печатаешь, она уже не доходит. Хоткей на голой букве делал
// эту букву ненабираемой вообще нигде, пока OwnCord запущен — забиндил
// мьют на «ю», и «ю» больше не напечатать ни в браузере, ни в игровом
// чате, ни в самом OwnCord.
//
// uIOhook, в отличие от него, слушает пассивно и событие не потребляет.
// Нажатие одновременно и мьютит микрофон, и печатается там, где был
// фокус. Именно так ведёт себя Discord.
//
// Безопасность. Хук видит поток нажатий — это неизбежно для такой
// задачи. Поэтому обращаемся с ним строго: событие сверяется с картой
// зарегистрированных биндов и при совпадении наружу уходит ТОЛЬКО имя
// действия ('toggleMute'). Ни код клавиши, ни содержимое набора никуда
// не пишутся, не логируются и не покидают main-процесс. Если ни одного
// биндинга не задано, хук вообще не запускается (см. register).
//
// macOS: uIOhook.start() требует Accessibility permission. Если юзер
// не выдал — start() не падает, но события не приходят. Мы не
// заморачиваемся фолбэком (приложение пока Windows-only), но и не
// крашимся, чтобы при будущей поддержке macOS не нужно было
// переписывать lifecycle.

const { uIOhook, UiohookKey } = require('uiohook-napi');

// Парсинг и matching ВНУТРИ модуля, без зависимостей от utils/desktop.ts —
// тот живёт в renderer'е и не доступен в main-процессе. Логика 1-в-1
// совпадает с client/src/utils/desktop.ts:isMouseAccelerator и
// client/src/hooks/useKeybinds.ts:parseAccelerator (см. там, чтобы
// знать, где править если меняется набор кнопок).
const MOUSE_RE = /^Mouse(Middle|[3-9]|\d{2})$/;

function isMouse(acc) {
  if (!acc) return false;
  const last = acc.split('+').pop() || '';
  return MOUSE_RE.test(last);
}

function parseAcc(acc) {
  const parts = acc.split('+');
  const out = { ctrl: false, alt: false, shift: false, key: '' };
  for (const p of parts) {
    if (p === 'CommandOrControl' || p === 'Command' || p === 'Control') out.ctrl = true;
    else if (p === 'Alt') out.alt = true;
    else if (p === 'Shift') out.shift = true;
    else out.key = p;
  }
  return out;
}

// libuiohook button-коды (см. https://github.com/kwhat/libuiohook):
//   1 = MOUSE_BUTTON1 (ЛКМ)        — игнорим, иначе сломаем UI-клики
//   2 = MOUSE_BUTTON2 (ПКМ)        — то же
//   3 = MOUSE_BUTTON3 (Middle/СКМ) → 'MouseMiddle'
//   4 = MOUSE_BUTTON4 (X1 / Back)  → 'Mouse4'
//   5 = MOUSE_BUTTON5 (X2 / Fwd.)  → 'Mouse5'
function buttonToKey(btn) {
  if (btn === 3) return 'MouseMiddle';
  if (btn === 4) return 'Mouse4';
  if (btn === 5) return 'Mouse5';
  return null;
}

// Обратная карта: keycode uIOhook -> имя клавиши в нашем формате
// акселератора. Имена UiohookKey почти совпадают с тем, что выдаёт
// keyEventToAccelerator в client/src/utils/desktop.ts (оно строит их из
// KeyboardEvent.code) — расходятся только несколько штук, их правим
// таблицей ниже.
//
// Важно, что сверка идёт по физической клавише, а не по символу: на
// русской раскладке «ю» — это та же клавиша, что «.» на латинской, и
// биндинг продолжает работать при смене языка.
const KEY_ALIASES = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Return',
  Escape: 'Esc',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  BracketLeft: '[',
  BracketRight: ']',
  Minus: '-',
  Equal: '=',
  Backquote: '`',
};

const KEYCODE_TO_NAME = (() => {
  const out = new Map();
  for (const [name, code] of Object.entries(UiohookKey || {})) {
    // Модификаторы сами по себе биндами не бывают — они приходят
    // отдельными флагами в событии.
    if (/^(Ctrl|Alt|Shift|Meta)(Right)?$/.test(name)) continue;
    out.set(code, KEY_ALIASES[name] || name);
  }
  return out;
})();

let binds = []; // [{ acc, action, parsed: { ctrl, alt, shift, key } }]
let win = null;
let hookStarted = false;
let listenerAttached = false;

function onMouseDown(e) {
  const key = buttonToKey(e.button);
  if (!key) return;
  for (const b of binds) {
    if (b.parsed.key !== key) continue;
    // Точное совпадение модификаторов — Ctrl+Mouse4 не должен срабатывать
    // на голый Mouse4 и наоборот (зеркалит useKeybinds.ts:matches).
    // CommandOrControl парсится в .ctrl=true; на macOS это означает Cmd
    // (e.metaKey), на Windows — настоящий Ctrl. Поэтому учитываем оба.
    const haveCtrl = !!(e.ctrlKey || e.metaKey);
    if (b.parsed.ctrl !== haveCtrl) continue;
    if (b.parsed.alt !== !!e.altKey) continue;
    if (b.parsed.shift !== !!e.shiftKey) continue;
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send('shortcut:fired', { action: b.action });
    } catch (err) {
      console.warn('mouseHook send failed:', err);
    }
    return;
  }
}

// Клавиатура. Логика сверки та же, что у мыши: точное совпадение
// модификаторов, чтобы Ctrl+M не срабатывал на голом M и наоборот.
function onKeyDown(e) {
  if (!binds.length) return;
  const name = KEYCODE_TO_NAME.get(e.keycode);
  if (!name) return;
  for (const b of binds) {
    if (b.parsed.key !== name) continue;
    const haveCtrl = !!(e.ctrlKey || e.metaKey);
    if (b.parsed.ctrl !== haveCtrl) continue;
    if (b.parsed.alt !== !!e.altKey) continue;
    if (b.parsed.shift !== !!e.shiftKey) continue;
    if (!win || win.isDestroyed()) return;
    try {
      // Наружу уходит только имя действия — см. блок про безопасность
      // в шапке файла.
      win.webContents.send('shortcut:fired', { action: b.action });
    } catch (err) {
      console.warn('inputHook send failed:', err);
    }
    return;
  }
}

function start() {
  if (!listenerAttached) {
    uIOhook.on('mousedown', onMouseDown);
    uIOhook.on('keydown', onKeyDown);
    listenerAttached = true;
  }
  if (!hookStarted) {
    try {
      uIOhook.start();
      hookStarted = true;
    } catch (e) {
      console.warn('uIOhook.start() failed:', e?.message || e);
    }
  }
}

function stop() {
  if (hookStarted) {
    try {
      uIOhook.stop();
    } catch {
      /* */
    }
    hookStarted = false;
  }
  if (listenerAttached) {
    try {
      uIOhook.removeListener('mousedown', onMouseDown);
      uIOhook.removeListener('keydown', onKeyDown);
    } catch {
      /* */
    }
    listenerAttached = false;
  }
}

function register(map, browserWindow) {
  win = browserWindow || null;
  binds = [];
  for (const [action, acc] of Object.entries(map || {})) {
    const v = (acc || '').trim();
    // Берём и мышиные, и клавиатурные — теперь оба типа обслуживает
    // этот модуль. Раньше клавиатурные отсеивались и уходили в
    // globalShortcut, который их проглатывал.
    if (!v) continue;
    binds.push({ acc: v, action, parsed: parseAcc(v), mouse: isMouse(v) });
  }
  // Ни одного биндинга — выключаем фоновый поток, чтобы не нагружать ОС
  // зря и не держать активным хук ввода без надобности.
  if (binds.length === 0) {
    stop();
    return [];
  }
  start();
  return binds.map((b) => b.acc);
}

function unregisterAll() {
  binds = [];
  win = null;
  stop();
}

module.exports = { register, unregisterAll };
