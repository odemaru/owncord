// Кастомный титлбар для Electron-десктопа.
//
// Зачем: дефолтный нативный фрейм Windows (белый/системный) визуально
// разрывает тёмный UI приложения. desktop/main.js теперь поднимает окно
// с frame:false, и эта компонента рисует свой 32-пиксельный бар,
// согласованный с темой OwnCord.
//
// Что делает:
//   • На Windows/Linux — иконка + название + три кнопки (свернуть,
//     развернуть/восстановить, закрыть) справа.
//   • На macOS — только иконка и название по центру; нативные «светофоры»
//     рендерятся системой через titleBarStyle:'hidden' (см. desktop/main.js).
//   • Перетаскивание окна: вся область с -webkit-app-region: drag, кроме
//     кнопок (no-drag), на которых должны срабатывать клики.
//   • Двойной клик по drag-области — toggleMaximize (Windows-конвенция).
//
// На вебе и в старых сборках десктопа (без preload.windowControls)
// компонента ничего не рендерит — getWindowControls() возвращает null.

import { useEffect, useState } from 'react';
import { Minus, Square, X, Copy } from 'lucide-react';
import { getDesktopPlatform, getWindowControls, isDesktop } from '../utils/desktop';

const BAR_HEIGHT = 32;

// Inline-стили: -webkit-app-region не имеет утилит в Tailwind, и проще
// держать значения в одном месте, чем плодить CSS-классы.
//
// React не имеет правильного типа для нестандартного CSS-свойства, поэтому
// объект собираем как Record<string, string|number> и кастуем при применении.
const dragStyle: any = { WebkitAppRegion: 'drag' };
const noDragStyle: any = { WebkitAppRegion: 'no-drag' };

export default function TitleBar() {
  // Решение «рендерить ли вообще» делаем синхронно при mount —
  // window.electronAPI выставляется preload'ом ещё до загрузки бандла,
  // поэтому isDesktop() даст финальный ответ сразу.
  const [enabled] = useState(() => isDesktop() && !!getWindowControls());
  const [platform] = useState<string | null>(() => getDesktopPlatform());
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!enabled) return undefined;
    const wc = getWindowControls();
    if (!wc) return undefined;
    // Синкаем начальное состояние и подписываемся на изменения.
    let cancelled = false;
    wc.isMaximized()
      .then((v) => {
        if (!cancelled) setMaximized(!!v);
      })
      .catch(() => {
        /* */
      });
    const off = wc.onState(({ maximized: m }) => {
      setMaximized(!!m);
    });
    return () => {
      cancelled = true;
      off?.();
    };
  }, [enabled]);

  if (!enabled) return null;

  const isMac = platform === 'darwin';

  const wc = getWindowControls();
  const onMinimize = () => wc?.minimize().catch(() => {});
  const onToggleMax = () => wc?.toggleMaximize().catch(() => {});
  const onClose = () => wc?.close().catch(() => {});

  // Двойной клик по drag-области — toggleMaximize. На macOS системное
  // поведение зависит от настроек System Preferences («двойной клик
  // увеличивает/сворачивает окно»), оставляем дефолт ОС — обработчик
  // не вешаем.
  const onDragDoubleClick = !isMac ? () => onToggleMax() : undefined;

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[1000] flex items-center select-none border-b border-white/5 bg-bg-0/95 backdrop-blur-sm"
      style={{ ...dragStyle, height: BAR_HEIGHT }}
      onDoubleClick={onDragDoubleClick}
    >
      {/* На macOS нативные «светофоры» лежат слева — оставляем им место. */}
      {isMac && <div style={{ width: 76 }} aria-hidden />}

      <div
        className="flex items-center gap-2 px-3 min-w-0 flex-1"
        style={dragStyle}
      >
        <img
          src="/favicon.svg"
          alt=""
          width={16}
          height={16}
          className="shrink-0 opacity-90"
          draggable={false}
        />
        <div className="text-xs font-semibold tracking-wide text-slate-300 truncate">
          OwnCord
        </div>
      </div>

      {/* Кнопки управления — только не на macOS (там traffic lights нативные). */}
      {!isMac && (
        <div className="flex items-stretch h-full" style={noDragStyle}>
          <TitleButton onClick={onMinimize} ariaLabel="Свернуть">
            <Minus size={14} />
          </TitleButton>
          <TitleButton onClick={onToggleMax} ariaLabel={maximized ? 'Восстановить' : 'Развернуть'}>
            {maximized ? <Copy size={12} /> : <Square size={12} />}
          </TitleButton>
          <TitleButton onClick={onClose} ariaLabel="Закрыть" danger>
            <X size={14} />
          </TitleButton>
        </div>
      )}
    </div>
  );
}

function TitleButton({
  onClick,
  ariaLabel,
  danger,
  children,
}: {
  onClick: () => void;
  ariaLabel: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  // Hover для close — красный (Windows-конвенция). У остальных — лёгкий
  // подсвет белым. Активный (mousedown) состояние делает цвет чуть темнее.
  // Все три кнопки фиксированной ширины 46px (как у нативных Win11).
  const hoverClass = danger
    ? 'hover:bg-[#e81123] hover:text-white active:bg-[#c50f1f]'
    : 'hover:bg-white/10 active:bg-white/15';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={ariaLabel}
      className={`grid place-items-center text-slate-300 transition-colors duration-100 ${hoverClass}`}
      style={{ width: 46, height: '100%' }}
    >
      {children}
    </button>
  );
}
