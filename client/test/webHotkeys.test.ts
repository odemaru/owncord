import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installWebHotkeys, setHotkeyCaptureMode } from '../src/utils/webHotkeys';

// Хоткеи в браузерной версии. Проверяем контракт: обработчик диспатчит
// то же DOM-событие 'owncord:shortcut', что и Electron-мост, поэтому
// useCall/useGroupCall работают с ним без изменений.

let fired: string[] = [];
let uninstall: (() => void) | null = null;

function onShortcut(ev: Event) {
  fired.push((ev as CustomEvent).detail?.action);
}

beforeEach(() => {
  fired = [];
  setHotkeyCaptureMode(false);
  window.addEventListener('owncord:shortcut', onShortcut);
});

afterEach(() => {
  window.removeEventListener('owncord:shortcut', onShortcut);
  uninstall?.();
  uninstall = null;
  setHotkeyCaptureMode(false);
});

function press(init: Partial<KeyboardEventInit> & { code: string }, target?: EventTarget) {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  (target || window).dispatchEvent(ev);
  return ev;
}

describe('installWebHotkeys', () => {
  it('срабатывает на назначенную комбинацию', () => {
    uninstall = installWebHotkeys({ toggleMute: 'CommandOrControl+Shift+M' });
    press({ code: 'KeyM', ctrlKey: true, shiftKey: true });
    expect(fired).toEqual(['toggleMute']);
  });

  it('различает разные действия', () => {
    uninstall = installWebHotkeys({ toggleMute: 'F8', toggleDeafen: 'F9' });
    press({ code: 'F9' });
    press({ code: 'F8' });
    expect(fired).toEqual(['toggleDeafen', 'toggleMute']);
  });

  it('игнорирует непривязанные клавиши', () => {
    uninstall = installWebHotkeys({ toggleMute: 'F8' });
    press({ code: 'F7' });
    press({ code: 'KeyM' });
    expect(fired).toEqual([]);
  });

  it('требует точного совпадения модификаторов', () => {
    uninstall = installWebHotkeys({ toggleMute: 'CommandOrControl+Shift+M' });
    press({ code: 'KeyM' }); // без модификаторов
    press({ code: 'KeyM', ctrlKey: true }); // без Shift
    expect(fired).toEqual([]);
  });

  it('гасит стандартное действие браузера на совпадении', () => {
    uninstall = installWebHotkeys({ toggleMute: 'F8' });
    const ev = press({ code: 'F8' });
    expect(ev.defaultPrevented).toBe(true);
  });

  it('не мешает браузеру, когда комбинация не назначена', () => {
    uninstall = installWebHotkeys({ toggleMute: 'F8' });
    const ev = press({ code: 'KeyW', ctrlKey: true });
    expect(ev.defaultPrevented).toBe(false);
  });

  it('молчит при наборе текста в input', () => {
    // Регрессия: с одиночной буквой в качестве хоткея набор сообщения
    // превращался в минное поле — «M» в слове мьютила микрофон.
    uninstall = installWebHotkeys({ toggleMute: 'M' });
    const input = document.createElement('input');
    document.body.appendChild(input);
    press({ code: 'KeyM' }, input);
    expect(fired).toEqual([]);
    input.remove();
  });

  it('молчит при наборе в textarea и contenteditable', () => {
    uninstall = installWebHotkeys({ toggleMute: 'M' });
    const ta = document.createElement('textarea');
    const div = document.createElement('div');
    div.contentEditable = 'true';
    // jsdom не реализует isContentEditable через атрибут — проставим явно.
    Object.defineProperty(div, 'isContentEditable', { value: true });
    document.body.append(ta, div);
    press({ code: 'KeyM' }, ta);
    press({ code: 'KeyM' }, div);
    expect(fired).toEqual([]);
    ta.remove();
    div.remove();
  });

  it('игнорирует автоповтор зажатой клавиши', () => {
    // Иначе тогл мигал бы десятки раз в секунду, пока клавиша зажата.
    uninstall = installWebHotkeys({ toggleMute: 'F8' });
    press({ code: 'F8' });
    press({ code: 'F8', repeat: true });
    press({ code: 'F8', repeat: true });
    expect(fired).toEqual(['toggleMute']);
  });

  it('молчит, пока идёт запись новой комбинации', () => {
    uninstall = installWebHotkeys({ toggleMute: 'F8' });
    setHotkeyCaptureMode(true);
    press({ code: 'F8' });
    expect(fired).toEqual([]);
    setHotkeyCaptureMode(false);
    press({ code: 'F8' });
    expect(fired).toEqual(['toggleMute']);
  });

  it('после отписки не срабатывает', () => {
    const off = installWebHotkeys({ toggleMute: 'F8' });
    off();
    press({ code: 'F8' });
    expect(fired).toEqual([]);
  });

  it('пустая карта привязок не вешает обработчиков', () => {
    const spy = vi.spyOn(window, 'addEventListener');
    const off = installWebHotkeys({ toggleMute: null, toggleDeafen: null });
    expect(spy).not.toHaveBeenCalled();
    off();
    spy.mockRestore();
  });

  it('ловит боковые кнопки мыши', () => {
    uninstall = installWebHotkeys({ toggleMute: 'Mouse4' });
    window.dispatchEvent(new MouseEvent('mousedown', { button: 3, bubbles: true, cancelable: true }));
    expect(fired).toEqual(['toggleMute']);
  });

  it('не занимает ЛКМ и ПКМ', () => {
    uninstall = installWebHotkeys({ toggleMute: 'Mouse4' });
    window.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true }));
    expect(fired).toEqual([]);
  });
});
