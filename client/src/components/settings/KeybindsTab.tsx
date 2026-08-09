// Таб «Горячие клавиши» (только desktop): запись глобальных хоткеев для
// мьюта микрофона и глушения собеседников. Запись — простая state-машина:
//   1) idle: показываем текущий accelerator + кнопки «Записать» / «Очистить».
//   2) recording: вешаем window-level listener'ы на keydown и mousedown.
//      Считаем accelerator на каждом нажатии (см. keyEventToAccelerator /
//      mouseEventToAccelerator); как только событие приносит основную
//      клавишу или мышиную кнопку (не только модификаторы) — записываем
//      accelerator в settings и выходим из recording.
//   3) Esc отменяет запись без изменений.
//
// Почему window-level, а не on-element: предыдущая версия вешала onKeyDown/
// onMouseDown на сам div и автофокусила его. Это требовало, чтобы курсор
// мыши БЫЛ внутри div'а в момент клика — иначе mousedown улетал куда-то
// ещё и клавиша/кнопка не записывалась. Самый частый сценарий: юзер
// нажал «Записать», машинально увёл курсор на боковую кнопку Mouse4
// чтобы её нажать — и ничего не произошло, потому что мышь уже за
// пределами поля. Window-level listener это лечит.
//
// Мышь: с 0.7.4 мышиные acc'ы работают глобально через uiohook-napi
// (см. utils/desktop.ts и desktop/mouseHook.js). Бывшее ограничение
// «только в фокусе» снято.
//
// settings.keybinds мутируется через update({ keybinds: { ... } }) —
// useKeybinds в Home.tsx видит новое значение и шлёт setShortcuts в main.
// Главное: keybinds — вложенный объект, а update делает Object.assign на
// верхнем уровне, поэтому мы СВОЕЙ рукой собираем полный объект и
// передаём его целиком (иначе случайно потеряем второй ключ).

import { useEffect, useState } from 'react';
import { Headphones, MicOff } from 'lucide-react';
import { useSettings } from '../../context/SettingsContext';
import {
  keyEventToAccelerator,
  mouseEventToAccelerator,
  formatAccelerator,
  isDesktop,
  type ShortcutAction,
} from '../../utils/desktop';
import { setHotkeyCaptureMode } from '../../utils/webHotkeys';

const KEYBIND_ACTIONS: { id: ShortcutAction; label: string; description: string; Icon: any }[] = [
  {
    id: 'toggleMute',
    label: 'Мьют микрофона',
    description: 'Переключить микрофон вкл/выкл (тогл).',
    Icon: MicOff,
  },
  {
    id: 'toggleDeafen',
    label: 'Глушить динамики',
    description: 'Переключить звук собеседников (тогл).',
    Icon: Headphones,
  },
];

function KeybindRow({
  action,
  label,
  description,
  Icon,
}: {
  action: ShortcutAction;
  label: string;
  description: string;
  Icon: any;
}) {
  const { settings, update } = useSettings();
  const [recording, setRecording] = useState(false);
  const current = settings.keybinds?.[action] || null;

  // Когда recording=true — слушаем window глобально (на стороне страницы).
  // ЛЮБОЙ keydown или mousedown в окне ловится; ЛКМ/ПКМ игнорим (нормальный
  // UI-клик), Esc отменяет, остальное записываем.
  //
  // useEffect-cleanup гарантирует снятие listener'ов при выходе из
  // recording-режима (writeKeybind → setRecording(false) → effect ре-ран
  // → старый cleanup снимет хвосты, новый ран ничего не вешает).
  useEffect(() => {
    if (!recording) return undefined;

    // Глушим боевые хоткеи на время записи. Иначе привязка мьюта на «M»
    // тут же этот мьют и переключит: веб-обработчик висит на window в той
    // же capture-фазе и зарегистрирован раньше нашего, так что сработал бы
    // первым, и stopPropagation ниже уже ничего не изменил бы.
    setHotkeyCaptureMode(true);

    const writeKeybind = (acc: string | null) => {
      update({
        keybinds: {
          ...(settings.keybinds || {}),
          [action]: acc,
        },
      });
    };

    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        setRecording(false);
        return;
      }
      const acc = keyEventToAccelerator(e);
      if (acc) {
        writeKeybind(acc);
        setRecording(false);
      }
      // Только модификаторы — продолжаем слушать.
    };

    const onMouse = (e: MouseEvent) => {
      // ЛКМ/ПКМ — это нормальный UI-клик, не пишем как acc (иначе клик
      // мимо «Записать» сразу записал бы мусор).
      if (e.button === 0 || e.button === 2) return;
      e.preventDefault();
      e.stopPropagation();
      const acc = mouseEventToAccelerator(e);
      if (acc) {
        writeKeybind(acc);
        setRecording(false);
      }
    };

    // capture=true — чтобы перехватить ДО любых других обработчиков
    // (например, чтобы X1/X2 не запустили browser-навигацию «Назад/Вперёд»
    // и не закрыли модалку настроек).
    window.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('mousedown', onMouse, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true } as any);
      window.removeEventListener('mousedown', onMouse, { capture: true } as any);
      // Снимаем блокировку в cleanup, а не рядом с setRecording(false):
      // так она гарантированно снимется и при размонтировании панели
      // настроек прямо в режиме записи (закрыли модалку на полпути).
      setHotkeyCaptureMode(false);
    };
  }, [recording, action, settings.keybinds, update]);

  const writeKeybind = (acc: string | null) => {
    update({
      keybinds: {
        ...(settings.keybinds || {}),
        [action]: acc,
      },
    });
  };

  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="text-slate-400 shrink-0">
        <Icon size={16} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm">{label}</div>
        <div className="text-[11px] text-slate-500 leading-snug">{description}</div>
      </div>
      <div className="flex items-center gap-2">
        {recording ? (
          <div
            // Поле — чисто визуальная плашка. Все события приходят с
            // window-listener'а в useEffect выше, и поэтому работают,
            // даже если курсор мыши вышел за пределы div'а.
            className="px-3 py-1.5 rounded-md text-xs bg-amber-500/15 border border-amber-500/40 text-amber-200 outline-none min-w-[160px] text-center font-mono select-none"
          >
            Нажми клавишу или мышь…
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setRecording(true)}
            className="px-3 py-1.5 rounded-md text-xs bg-bg-3 hover:bg-bg-1 border border-border min-w-[160px] text-center font-mono"
            title="Записать новую комбинацию"
          >
            {current ? formatAccelerator(current) : 'Не назначено'}
          </button>
        )}
        <button
          type="button"
          onClick={() => writeKeybind(null)}
          disabled={!current && !recording}
          className="btn-ghost text-xs"
          title="Снять хоткей"
        >
          Сбросить
        </button>
      </div>
    </div>
  );
}

export function KeybindsTab() {
  return (
    <section className="space-y-4">
      <div className="text-xs text-slate-400 leading-snug space-y-1.5">
        <div>
          Поддерживаются и клавиатура, и боковые кнопки мыши (Mouse&nbsp;4 / Mouse&nbsp;5 / СКМ).
          Примеры: <code className="text-[11px]">Ctrl+Shift+M</code>,{' '}
          <code className="text-[11px]">F8</code>.
        </div>
        {isDesktop() ? (
          <div>
            Срабатывают глобально, даже когда окно OwnCord свёрнуто или не в фокусе. Клавиша при
            этом не «съедается»: если забиндить мьют на одиночную букву, она продолжит печататься
            там, где стоит курсор — нажатие и замьютит, и наберётся.
          </div>
        ) : (
          <div>
            В браузере хоткеи работают, пока вкладка OwnCord активна — страница просто не видит
            нажатия, ушедшие в другое окно. Чтобы мьютиться прямо из игры или поверх любого
            приложения, нужна десктоп-версия. Комбинации, занятые самим браузером (например{' '}
            <code className="text-[11px]">Ctrl+W</code>), лучше не назначать.
          </div>
        )}
        <div>
          Одиночные буквы без модификаторов брать можно — во время набора сообщения они не
          сработают.
        </div>
      </div>

      <div className="rounded-lg border border-border divide-y divide-border bg-bg-2">
        {KEYBIND_ACTIONS.map(({ id, label, description, Icon }) => (
          <KeybindRow key={id} action={id} label={label} description={description} Icon={Icon} />
        ))}
      </div>

      <div className="text-[11px] text-slate-500 leading-snug">
        Esc — отменить запись комбинации. «Сбросить» — снять привязку.
      </div>
    </section>
  );
}
