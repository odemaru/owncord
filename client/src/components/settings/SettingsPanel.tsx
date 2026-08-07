// Главный компонент окна настроек: модалка со списком табов слева и
// контентом справа. Сами табы лежат в собственных файлах
// (см. ./ProfileTab, ./PasswordTab, …) — этот файл только роутит между
// ними и решает, какие пункты вообще показывать (admin/desktop only).

import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  AppWindow,
  Bell,
  Headphones,
  KeyRound,
  Keyboard,
  Lock,
  ShieldCheck,
  User,
  X,
} from 'lucide-react';
import { modalVariants, overlayVariants, reducedVariants } from '../../utils/motion';
import { useAuth } from '../../context/AuthContext';
import {
  isDesktop,
  getDesktopVersion,
  checkForUpdates,
  installUpdate,
  onUpdateEvent,
  getUpdateState,
  type UpdateEvent,
} from '../../utils/desktop';
import { ProfileTab } from './ProfileTab';
import { PasswordTab } from './PasswordTab';
import { AudioTab } from './AudioTab';
import { NotificationsTab } from './NotificationsTab';
import { KeybindsTab } from './KeybindsTab';
import { PrivacyTab } from './PrivacyTab';
import { InvitesTab } from './InvitesTab';
import { AppTab } from './AppTab';

// adminOnly — видна только админам; desktopOnly — только в Electron-обёртке.
// Логика фильтрации в render'е панели (см. TABS).
const ALL_TABS = [
  { id: 'profile', label: 'Профиль', icon: User },
  { id: 'password', label: 'Пароль', icon: Lock },
  { id: 'audio', label: 'Звук', icon: Headphones },
  { id: 'notifications', label: 'Уведомления', icon: Bell },
  // Не desktopOnly: на вебе хоткеи тоже работают, пока вкладка в фокусе
  // (см. utils/webHotkeys.ts). Глобально, поверх других приложений, —
  // по-прежнему только в десктопе.
  { id: 'keybinds', label: 'Горячие клавиши', icon: Keyboard },
  { id: 'app', label: 'Приложение', icon: AppWindow, desktopOnly: true },
  { id: 'privacy', label: 'Приватность', icon: ShieldCheck },
  { id: 'invites', label: 'Приглашения', icon: KeyRound, adminOnly: true },
];

export default function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { auth } = useAuth();
  const isAdmin = !!auth?.user?.isAdmin;
  const desktop = isDesktop();
  const TABS = ALL_TABS.filter((t) => {
    if (t.adminOnly && !isAdmin) return false;
    if (t.desktopOnly && !desktop) return false;
    return true;
  });
  const [tab, setTab] = useState('profile');
  // Версия десктоп-приложения (null на вебе) — показываем мелким шрифтом
  // в подвале сайдбара. На веб-версии футер с версией не рендерим вовсе.
  const [desktopVersion, setDesktopVersion] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void getDesktopVersion().then((v) => {
      if (alive) setDesktopVersion(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Локальное состояние ручной проверки обновлений (только в десктопе).
  // updateState отражает последнее событие из onUpdateEvent — этого
  // достаточно для inline-фидбэка в подвале сайдбара. Полный UI прогресса
  // и кнопка перезапуска живут в UpdateToast, чтобы не дублировать логику.
  const [updateState, setUpdateState] = useState<UpdateEvent | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (!desktop) return;
    // На mount подтягиваем закэшированный state у main-процесса — нужно
    // для случая, когда фоновая проверка скачала installer ДО открытия
    // настроек (тогда оригинальный 'downloaded' event прошёл мимо, а
    // повторный checkForUpdates() для уже-скачанного файла молчит и UI
    // зависает в watchdog'е на 60 сек). Если кэш есть и пользователь
    // ещё не получал свежий event — применим cached.
    let cancelled = false;
    void getUpdateState().then((cached) => {
      if (cancelled || !cached) return;
      setUpdateState((prev) => prev ?? cached);
    });
    const off = onUpdateEvent((ev) => {
      setUpdateState(ev);
      // 'checking' приходит от main и снаружи (фоновая периодическая
      // проверка). Сбросим локальный флаг только на терминальных
      // состояниях, чтобы кнопка не разблокировалась раньше времени.
      if (ev.kind !== 'checking') setChecking(false);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [desktop]);

  const updateInFlight =
    checking ||
    updateState?.kind === 'checking' ||
    updateState?.kind === 'available' ||
    updateState?.kind === 'progress';
  const updateReady = updateState?.kind === 'downloaded';

  // Раньше здесь был watchdog на 60 секунд, который аварийно показывал
  // «Нет ответа от сервера обновлений», если за минуту не приходило ни
  // одного апдейта статуса. На практике этот таймаут срабатывал ЛОЖНО:
  //
  //   - Между fallback'ом differential download → full download есть
  //     пауза в несколько секунд, и electron-updater временно не шлёт
  //     'download-progress' event'ы.
  //   - 'checking-for-update' эмитится один раз, а потом фоновый download
  //     может идти 30-90 секунд молча между прогресс-тиками (на медленном
  //     канале большие куски без подтверждения).
  //   - Если пользователь нажал «Проверить», когда фоновый poll УЖЕ
  //     запустил download, второй checkForUpdates() возвращает тот же
  //     уже идущий downloadPromise, не эмитя новых события — UI ждёт
  //     то, чего никогда не будет.
  //
  // В реальном «нет сети / сервер не отвечает» electron-updater САМ
  // эмитит 'error' event через свой внутренний таймаут, и мы получим
  // нормальный UI-стейт error без необходимости в собственном watchdog'е.
  // Так что просто удалили — UI теперь честно показывает текущую стадию
  // и переходит в downloaded/error/none только когда action-флоу
  // реально завершится.

  const onUpdateButton = useCallback(async () => {
    if (updateReady) {
      void installUpdate();
      return;
    }
    if (updateInFlight) return;
    setChecking(true);
    setUpdateState({ kind: 'checking' });
    const res = await checkForUpdates();
    if (!res) {
      // Не в десктопе либо preload без хендлера — просто откатываем.
      setChecking(false);
      setUpdateState(null);
      return;
    }
    if (!res.ok) {
      setChecking(false);
      setUpdateState({ kind: 'error', message: res.error || 'Не удалось проверить' });
    }
    // При ok=true финальный стейт ('available'/'none'/'downloaded'/'error')
    // придёт через onUpdateEvent — там и обновим UI.
  }, [updateReady, updateInFlight]);

  const updateStatusText = (() => {
    if (!updateState) return null;
    switch (updateState.kind) {
      case 'checking':
        return 'Проверяю…';
      case 'available':
        return updateState.version
          ? `Доступна ${updateState.version}, скачиваю…`
          : 'Доступно обновление, скачиваю…';
      case 'progress':
        return `Загрузка ${Math.max(0, Math.min(100, Math.round(updateState.percent)))}%`;
      case 'downloaded':
        return updateState.version
          ? `Готово к установке (${updateState.version})`
          : 'Готово к установке';
      case 'none':
        return 'Установлена последняя версия';
      case 'error':
        return `Ошибка: ${updateState.message}`;
      default:
        return null;
    }
  })();
  const reduce = useReducedMotion();
  const overlayV = reduce ? reducedVariants(overlayVariants) : overlayVariants;
  const panelV = reduce ? reducedVariants(modalVariants) : modalVariants;
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="settings"
          className="fixed inset-0 z-[55] bg-black/60 backdrop-blur-sm grid place-items-center p-4"
          onClick={onClose}
          variants={overlayV}
          initial="initial"
          animate="animate"
          exit="exit"
        >
          <motion.div
            className="card w-full max-w-3xl h-[min(640px,90vh)] overflow-hidden flex flex-col md:flex-row"
            onClick={(e) => e.stopPropagation()}
            variants={panelV}
          >
            {/* Sidebar */}
            <aside className="md:w-56 shrink-0 bg-bg-2 md:border-r border-b md:border-b-0 border-border p-3 flex md:flex-col gap-1 overflow-x-auto md:overflow-x-visible">
              <div className="hidden md:block text-xs uppercase tracking-wider text-slate-500 px-2 mb-2">
                Настройки
              </div>
              {TABS.map((t) => {
                const Icon = t.icon;
                const active = tab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    type="button"
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm whitespace-nowrap transition-colors
                  ${active ? 'bg-accent text-white' : 'text-slate-200 hover:bg-bg-3'}`}
                  >
                    <Icon size={16} />
                    <span>{t.label}</span>
                  </button>
                );
              })}
              {/* Подвал сайдбара — только в Electron'е, прибит к низу.
                  Содержит: версию приложения и ссылку-текст для ручной
                  проверки обновлений (без иконок/фона, стилизована как
                  неявный link). На вебе/мобильном горизонтальном скролле
                  скрыт через hidden md:flex. */}
              {desktop && (
                <div className="hidden md:flex mt-auto pt-3 px-2 flex-col gap-0.5">
                  {desktopVersion && (
                    <div className="text-[10px] text-slate-500 select-text">
                      OwnCord {desktopVersion}
                    </div>
                  )}
                  {/* Во время in-flight (checking/available/progress) сам
                      текст строки отражает статус — так пользователь видит
                      прогресс без отдельной второй строки. Статус 'none'/
                      'error' показываем в отдельной строке под ссылкой,
                      чтобы ссылка оставалась кликабельной («Проверить
                      снова»). */}
                  <button
                    type="button"
                    onClick={onUpdateButton}
                    disabled={updateInFlight && !updateReady}
                    className={`text-left text-[10px] w-fit transition-colors ${
                      updateReady
                        ? 'text-accent hover:text-accent-hover cursor-pointer'
                        : 'text-slate-500 hover:text-slate-300 cursor-pointer'
                    } disabled:cursor-default disabled:hover:text-slate-500`}
                    title={
                      updateReady
                        ? 'Перезапустить и применить обновление'
                        : 'Проверить наличие обновлений сейчас'
                    }
                  >
                    {updateReady
                      ? 'Перезапустить и обновить'
                      : updateInFlight
                        ? updateStatusText || 'Проверяю…'
                        : 'Проверить обновления'}
                  </button>
                  {!updateInFlight && !updateReady && updateStatusText && (
                    <div
                      className={`text-[10px] leading-snug break-words ${
                        updateState?.kind === 'error' ? 'text-danger' : 'text-slate-600'
                      }`}
                    >
                      {updateStatusText}
                    </div>
                  )}
                </div>
              )}
            </aside>

            {/* Content */}
            <div className="flex-1 min-w-0 flex flex-col">
              <div className="flex items-center justify-between px-5 py-3 border-b border-border">
                <div className="text-base font-semibold">
                  {TABS.find((t) => t.id === tab)?.label}
                </div>
                <button className="btn-ghost" onClick={onClose} title="Закрыть">
                  <X size={18} />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-5">
                {tab === 'profile' && <ProfileTab />}
                {tab === 'password' && <PasswordTab />}
                {tab === 'audio' && <AudioTab />}
                {tab === 'notifications' && <NotificationsTab />}
                {/* Без гейта по desktop: хоткеи работают и в браузере,
                    пока вкладка в фокусе (см. utils/webHotkeys.ts). Гейт
                    тут держался парой к desktopOnly в ALL_TABS, и когда
                    тот сняли — вкладка стала открываться пустой. */}
                {tab === 'keybinds' && <KeybindsTab />}
                {tab === 'app' && desktop && <AppTab />}
                {tab === 'privacy' && <PrivacyTab />}
                {tab === 'invites' && isAdmin && <InvitesTab />}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
