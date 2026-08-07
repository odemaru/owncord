// Хоткеи для браузерной версии.
//
// В десктопе мьют и глушение висят на Electron globalShortcut + uiohook и
// работают на уровне ОС, даже когда окно свёрнуто (см. utils/desktop.ts и
// desktop/mouseHook.js). На вебе такого API нет и быть не может: страница
// видит только те события, что приходят в её окно. Поэтому здесь —
// window-level listener, работающий, пока вкладка OwnCord в фокусе.
//
// Ключевое архитектурное решение: этот модуль НЕ вызывает toggleMute сам,
// а диспатчит ровно то же DOM-событие 'owncord:shortcut', что шлёт
// preload.js в десктопе. Благодаря этому useCall и useGroupCall остаются
// нетронутыми — им всё равно, откуда прилетел хоткей, и не появляется
// второй, расходящийся путь обработки.
//
// Сопоставление нажатия с сохранённой привязкой сделано через те же
// keyEventToAccelerator / mouseEventToAccelerator, которыми пользуется
// рекордер в settings/KeybindsTab. Сравниваем строки: что записали — то и
// ищем. Это гарантирует, что запись и срабатывание не разъедутся, даже
// если завтра поменяется раскладка acc-строк.

import {
  keyEventToAccelerator,
  mouseEventToAccelerator,
  type ShortcutAction,
  type Shortcuts,
} from './desktop';

// Пока пользователь записывает новую комбинацию в настройках, хоткеи
// должны молчать. Иначе запись мьюта на «M» тут же этот мьют и включит.
//
// Флаг, а не хитрости с порядком listener'ов: и рекордер, и мы висим на
// window в capture-фазе, а порядок там — порядок регистрации. Наш
// listener ставится раньше (при монтировании Home), значит сработал бы
// первым, и stopPropagation рекордера уже не помог бы.
let capturing = false;

export function setHotkeyCaptureMode(active: boolean): void {
  capturing = active;
}

// Не перехватываем нажатия, когда пользователь печатает. Без этой
// проверки привязка на одиночную клавишу превращает набор сообщения в
// минное поле: буква «M» в слове мьютит микрофон.
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (el.isContentEditable) return true;
  return false;
}

/**
 * Повесить обработчики хоткеев на окно. Возвращает функцию отписки.
 *
 * @param keybinds карта action → accelerator ('CommandOrControl+Shift+M',
 *                 'F8', 'Mouse4', …). Пустые значения игнорируются.
 */
export function installWebHotkeys(keybinds: Shortcuts): () => void {
  // Инвертируем карту: accelerator → action. Так на каждое нажатие
  // делается один поиск по хэшу вместо перебора всех привязок.
  const byAccel = new Map<string, ShortcutAction>();
  for (const [action, accel] of Object.entries(keybinds)) {
    if (accel) byAccel.set(accel, action as ShortcutAction);
  }
  if (byAccel.size === 0) {
    return () => {
      /* нечего слушать */
    };
  }

  const fire = (action: ShortcutAction) => {
    window.dispatchEvent(new CustomEvent('owncord:shortcut', { detail: { action } }));
  };

  const onKey = (e: KeyboardEvent) => {
    if (capturing) return;
    // Автоповтор при зажатой клавише: тогл иначе мигает десятки раз в секунду.
    if (e.repeat) return;
    if (isTypingTarget(e.target)) return;
    const accel = keyEventToAccelerator(e);
    if (!accel) return; // нажаты только модификаторы
    const action = byAccel.get(accel);
    if (!action) return;
    // Гасим штатное действие браузера: например, F-клавиши и
    // Ctrl-комбинации иначе откроют меню или поиск по странице.
    e.preventDefault();
    e.stopPropagation();
    fire(action);
  };

  const onMouse = (e: MouseEvent) => {
    if (capturing) return;
    if (e.button === 0 || e.button === 2) return; // ЛКМ/ПКМ не занимаем
    const accel = mouseEventToAccelerator(e);
    if (!accel) return;
    const action = byAccel.get(accel);
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    fire(action);
  };

  // Боковые кнопки мыши в браузере — это «Назад»/«Вперёд». preventDefault
  // на mousedown их не всегда останавливает: часть браузеров навигируют по
  // auxclick. Гасим и его, иначе мьют на Mouse4 будет уводить со страницы.
  const onAux = (e: MouseEvent) => {
    if (capturing) return;
    if (e.button === 0 || e.button === 2) return;
    const accel = mouseEventToAccelerator(e);
    if (accel && byAccel.has(accel)) e.preventDefault();
  };

  // capture=true, чтобы перехватить нажатие раньше обработчиков внутри
  // приложения. Опции обязаны совпадать при add/remove, иначе listener
  // не снимется — держим их одной константой.
  const opts = { capture: true } as const;
  window.addEventListener('keydown', onKey, opts);
  window.addEventListener('mousedown', onMouse, opts);
  window.addEventListener('auxclick', onAux, opts);
  return () => {
    window.removeEventListener('keydown', onKey, opts);
    window.removeEventListener('mousedown', onMouse, opts);
    window.removeEventListener('auxclick', onAux, opts);
  };
}
