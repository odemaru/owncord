import { lazy, memo, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  PhoneOff,
  Users as UsersIcon,
  ScreenShare,
  ScreenShareOff,
  Volume2,
  VolumeX,
  Settings,
  Pin,
  PinOff,
  X,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import Avatar from './Avatar';
import ScreenQualityModal from './ScreenQualityModal';
import { useSettings } from '../context/SettingsContext';
import { getAvatarUrl, getDisplayName } from '../utils/user';

const SettingsPanel = lazy(() => import('./SettingsPanel'));

type StreamVideoProps = {
  stream: MediaStream | null;
  muted?: boolean;
  className?: string;
  mirror?: boolean;
  onSize?: (w: number, h: number) => void;
};

const StreamVideo = memo(function StreamVideo({
  stream,
  muted = false,
  className = '',
  mirror = false,
  onSize,
}: StreamVideoProps) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream || null;
  }, [stream]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof onSize !== 'function') return;
    const report = () => onSize(el.videoWidth || 0, el.videoHeight || 0);
    el.addEventListener('resize', report);
    el.addEventListener('loadedmetadata', report);
    el.addEventListener('playing', report);
    report();
    return () => {
      el.removeEventListener('resize', report);
      el.removeEventListener('loadedmetadata', report);
      el.removeEventListener('playing', report);
    };
  }, [stream, onSize]);
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className={className}
      style={mirror ? { transform: 'scaleX(-1)' } : undefined}
    />
  );
});

type RemoteAudioProps = {
  stream: MediaStream | null;
  sinkId?: string;
  volume?: number;
  muted?: boolean;
};

const RemoteAudio = memo(function RemoteAudio({
  stream,
  sinkId,
  volume,
  muted = false,
}: RemoteAudioProps) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream || null;
    if (stream)
      el.play?.().catch(() => {
        /* autoplay policy */
      });
  }, [stream]);
  // Громкость и mute накладываем только на сам <audio>. Трогать track.enabled
  // на receiver-стороне нельзя: тот же MediaStreamTrack читает
  // useSpeakingDetector (AnalyserNode); если выключить трек — зелёная рамка
  // «говорит» перестаёт работать у deafen-нутого. Видео-плитки замьючены
  // через muted-проп (см. Tile), так что единственный аудио-выход — этот.
  // Зависим от stream защитно — переустановка свойств идемпотентна.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.volume = Math.max(0, Math.min(1, volume ?? 1));
    el.muted = !!muted;
  }, [stream, muted, volume]);
  useEffect(() => {
    const el = ref.current;
    if (!el || !sinkId || typeof el.setSinkId !== 'function') return;
    el.setSinkId(sinkId === 'default' ? '' : sinkId).catch(() => {
      /* not supported */
    });
  }, [sinkId]);
  return <audio ref={ref} autoPlay />;
});

/**
 * Плитка одного участника. Всегда рендерит <video> с remote-стримом
 * (даже если внутри placeholder), а аватар оверлеит сверху, пока RTP
 * не начнёт приносить реальные кадры. Триггер — событие `resize` на
 * <video>, оно надёжно срабатывает когда у удалённого трека меняется
 * разрешение (после replaceTrack у пира на screen/camera).
 *
 * Placeholder с нашей стороны — ровно 320×180, фильтруем его по
 * фактическим videoWidth/videoHeight тега <video>.
 */
function Tile({
  stream,
  user,
  self = false,
  muted = false,
  deafened = false,
  mirror = false,
  className = '',
  onClick,
  onContextMenu = undefined,
  pinned,
  pinnable,
  speaking = false,
  fullscreenable = false,
}) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [isFs, setIsFs] = useState(false);
  const hasStream = !!stream && stream.getVideoTracks().length > 0;
  // 0×0 — поток ещё не догнал; 320×180 — наш живой placeholder.
  // В обоих случаях аватар поверх. Любое другое разрешение = реальная
  // картинка (камера/демонстрация).
  const isPlaceholderSize = size.w === 0 || size.h === 0 || (size.w === 320 && size.h === 180);
  const showAvatar = !hasStream || isPlaceholderSize;
  const showFs = fullscreenable && hasStream && !isPlaceholderSize;
  const name = getDisplayName(user) || '?';
  // Стабильная ссылка на колбэк, чтобы StreamVideo не пере-подписывался
  // на каждый рендер.
  const onSize = useMemo(
    () => (w, h) => {
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    },
    [],
  );

  // Слушаем нативный fullscreenchange — Esc / API-выход должны синкаться
  // с UI-кнопкой (Maximize2 ↔ Minimize2).
  useEffect(() => {
    const handler = () => {
      setIsFs(document.fullscreenElement === wrapRef.current);
    };
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const toggleFullscreen = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    const el = wrapRef.current;
    if (!el) return;
    try {
      if (document.fullscreenElement === el) {
        document.exitFullscreen?.();
      } else {
        const req =
          el.requestFullscreen ||
          (el as any).webkitRequestFullscreen ||
          (el as any).msRequestFullscreen;
        req?.call(el);
      }
    } catch {
      /* not supported / denied */
    }
  };

  return (
    <div
      ref={wrapRef}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDoubleClick={
        showFs
          ? (e) => {
              e.stopPropagation();
              toggleFullscreen();
            }
          : undefined
      }
      className={`relative bg-bg-2 rounded-xl overflow-hidden border-2 group ${
        speaking
          ? // Зелёная рамка + мягкое свечение, когда участник говорит.
            // Полупрозрачное свечение видно даже поверх реальной видеокартинки.
            'border-emerald-400 shadow-[0_0_0_2px_rgba(16,185,129,0.45),0_0_18px_2px_rgba(16,185,129,0.35)]'
          : 'border-border'
      } transition-colors duration-100 ${
        pinnable ? 'cursor-pointer hover:border-accent' : ''
      } ${className}`}
    >
      {hasStream && (
        <StreamVideo
          stream={stream}
          muted
          mirror={mirror}
          onSize={onSize}
          className="w-full h-full object-contain bg-black"
        />
      )}
      {showAvatar && (
        <div className="absolute inset-0 grid place-items-center bg-bg-2">
          <Avatar name={name} src={getAvatarUrl(user)} size={72} />
        </div>
      )}
      {/* Кнопка фуллскрина — только когда у плитки есть реальная картинка
          (не аватарка/placeholder). stopPropagation, чтобы клик НЕ дёргал
          pin/unpin плитки. */}
      {showFs && (
        <button
          type="button"
          onClick={toggleFullscreen}
          // На мыши кнопка проявляется по наведению, чтобы не засорять сетку.
          // На тач-устройствах hover'а не существует, и без явного
          // [@media(hover:none)] кнопка была бы там невидимой навсегда —
          // с телефона развернуть чужую демонстрацию стало бы нечем.
          className="absolute top-2 right-2 z-20 btn-icon bg-black/60 hover:bg-black/80 text-white border border-white/10 backdrop-blur opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity"
          style={{ width: 32, height: 32 }}
          title={isFs ? 'Выйти из полноэкранного режима' : 'Развернуть на весь экран'}
          aria-label={isFs ? 'Выйти из полноэкранного режима' : 'Полноэкранный режим'}
        >
          {isFs ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      )}
      <div className="absolute bottom-2 left-2 right-2 flex items-center gap-1.5 px-2 py-1 rounded-md bg-black/60 backdrop-blur text-xs">
        <span className="truncate flex-1">
          {name}
          {self && <span className="text-slate-400"> (вы)</span>}
        </span>
        {deafened && <VolumeX size={12} className="text-amber-400 shrink-0" />}
        {muted && <MicOff size={12} className="text-amber-400 shrink-0" />}
        {pinned && <Pin size={12} className="text-accent shrink-0" />}
      </div>
    </div>
  );
}

// `embedded` режим — рендерим групповой звонок не как fullscreen
// оверлей, а как блок внутри main-панели чата. См. комментарий в
// CallView.tsx — мотивация общая.
export default function GroupCallView({
  call,
  usersById,
  selfId,
  embedded = false,
}: {
  call: any;
  usersById: any;
  selfId: number;
  embedded?: boolean;
}) {
  const { settings, update } = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  // pinnedKey: 'self' | userId | null. Когда запинен участник —
  // его плитка растягивается на всё основное поле, остальные
  // уходят в верхний стрип.
  const [pinnedKey, setPinnedKey] = useState(null);
  const [streamVolumeMenu, setStreamVolumeMenu] = useState<{
    x: number;
    y: number;
    userId: number;
  } | null>(null);
  const {
    state,
    group,
    localStream,
    remotes,
    participants,
    peersMedia,
    muted,
    deafened,
    cameraOn,
    sharingScreen,
    withVideo,
    speakingUserIds,
    toggleMute,
    toggleDeafen,
    toggleCamera,
    toggleScreenShare,
    leave,
  } = call;

  // ВСЕ хуки должны вызываться ДО любого early return — иначе React
  // ругается «Rendered more/fewer hooks than during the previous render»
  // и весь оверлей уходит в чёрный экран при первом переходе из idle.
  const tiles = useMemo(() => {
    const list: any[] = [{ kind: 'self', key: 'self' }];
    for (const uid of participants || []) {
      if (uid === selfId) continue;
      list.push({ kind: 'remote', userId: uid, key: uid });
    }
    return list;
  }, [participants, selfId]);

  // Если пиннутый участник ушёл — сбрасываем пин.
  useEffect(() => {
    if (pinnedKey === null || pinnedKey === 'self') return;
    if (!participants.includes(pinnedKey)) setPinnedKey(null);
  }, [participants, pinnedKey]);

  // Если участник, для которого сейчас открыто меню громкости, ушёл —
  // закрываем меню.
  useEffect(() => {
    if (!streamVolumeMenu) return;
    const uid = streamVolumeMenu.userId;
    if (!participants.includes(uid)) {
      setStreamVolumeMenu(null);
    }
  }, [streamVolumeMenu, participants]);

  if (state === 'idle') return null;

  const selfUser = usersById?.[selfId] || null;

  const peopleLabel = `${participants.length} участник${
    participants.length === 1 ? '' : participants.length < 5 ? 'а' : 'ов'
  }`;

  const renderTile = (t, opts: { suffix?: string; className?: string } = {}) => {
    const isPinned = pinnedKey === t.key;
    const onTileClick = () => {
      setPinnedKey((cur) => (cur === t.key ? null : t.key));
    };
    // Самозамьюченный участник не должен подсвечиваться, даже если
    // в треке вдруг проскочил шум — это запутывает остальных.
    const speaks = (uid) => speakingUserIds?.has?.(uid) === true;
    if (t.kind === 'self') {
      return (
        <Tile
          key={`tile-self${opts.suffix || ''}`}
          stream={localStream}
          user={selfUser || { displayName: 'Вы' }}
          self
          muted={muted}
          deafened={deafened}
          mirror={cameraOn}
          onClick={onTileClick}
          pinned={isPinned}
          pinnable
          fullscreenable
          speaking={!muted && speaks(selfId)}
          className={opts.className}
        />
      );
    }
    const u = usersById?.[t.userId] ||
      group?.members?.find((m) => m.id === t.userId) || {
        id: t.userId,
        displayName: `#${t.userId}`,
      };
    const onTileContextMenu = (e: React.MouseEvent) => {
      e.preventDefault();
      setStreamVolumeMenu({ x: e.clientX, y: e.clientY, userId: t.userId });
    };
    const peerM = peersMedia?.[t.userId];
    return (
      <Tile
        key={`tile-${t.userId}${opts.suffix || ''}`}
        stream={remotes[t.userId]}
        user={u}
        // Мьют микрофона и глушение наушников у собеседника — из сигналинга
        // groupcall:media:state. peerM может быть undefined на первых рендерах,
        // пока пир ещё не скинул state — рисуем без иконок (по дефолту
        // считаем что микрофон включён и наушники работают).
        muted={peerM ? !peerM.mic : false}
        deafened={!!peerM?.deafened}
        onClick={onTileClick}
        onContextMenu={onTileContextMenu}
        pinned={isPinned}
        pinnable
        fullscreenable
        speaking={speaks(t.userId)}
        className={opts.className}
      />
    );
  };

  const pinnedTile = pinnedKey ? tiles.find((t) => t.key === pinnedKey) : null;
  const otherTiles = pinnedTile ? tiles.filter((t) => t.key !== pinnedKey) : tiles;

  // Grid для «не пин-режима» — адаптивно по количеству. ВАЖНО: задаём
  // и cols, и rows явно через repeat(N, minmax(0, 1fr)) — иначе rows
  // получают auto-height (= max-content от <video>), и плитки разной
  // высоты разбегаются друг с другом (особенно когда у одного пира
  // placeholder 320×180, а у другого реальная картинка 1920×1080).
  // С gridTemplateRows все плитки одинакового размера = container/N.
  //
  // Если tiles.length не заполняет всю сетку (например 3 в 2×2) —
  // одна ячейка остаётся пустой, но плитки сохраняют пропорции.
  const gridCols = tiles.length <= 1 ? 1 : tiles.length <= 4 ? 2 : tiles.length <= 9 ? 3 : 4;
  const gridRows = Math.max(1, Math.ceil(tiles.length / gridCols));

  // См. комментарий в CallView.tsx — embedded даёт блок-в-чате; иначе
  // fullscreen-overlay (старое поведение, оставлено на случай если
  // понадобится развернуть звонок поверх всего UI).
  const rootClass = embedded
    ? 'relative w-full h-full flex flex-col bg-bg-0 border-b border-border min-h-0'
    : 'fixed inset-0 z-40 bg-bg-0 flex flex-col';

  return (
    <div className={rootClass}>
      <div className="flex-1 relative overflow-hidden p-3 min-h-0">
        {pinnedTile ? (
          <div className="w-full h-full flex flex-col gap-2">
            <div className="flex-1 min-h-0">
              {renderTile(pinnedTile, { suffix: '-pin', className: 'w-full h-full' })}
            </div>
            {otherTiles.length > 0 && (
              <div className="flex gap-2 overflow-x-auto py-1" style={{ height: 120 }}>
                {otherTiles.map((t) => (
                  <div
                    key={`strip-${t.key}`}
                    className="shrink-0"
                    style={{ width: 180, height: '100%' }}
                  >
                    {renderTile(t, { suffix: '-strip', className: 'w-full h-full' })}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div
            className="grid gap-2 w-full h-full"
            style={{
              gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
              gridTemplateRows: `repeat(${gridRows}, minmax(0, 1fr))`,
            }}
          >
            {tiles.map((t) => renderTile(t, { className: 'w-full h-full min-w-0 min-h-0' }))}
          </div>
        )}

        {/* Невидимые аудио-элементы для каждого пира (кроме self). */}
        {participants
          .filter((id) => id !== selfId)
          .map((uid) => {
            const base = settings.outputVolume ?? 1;
            const hasScreenAudio = !!peersMedia?.[uid]?.screenAudio;
            const userMul = Math.max(0, Math.min(1, (settings.userVolumes?.[uid] ?? 100) / 100));
            const streamMul = Math.max(
              0,
              Math.min(1, (settings.streamVolumes?.[uid] ?? 100) / 100),
            );
            return (
              <RemoteAudio
                key={`a-${uid}`}
                stream={remotes[uid]}
                sinkId={settings.outputDeviceId}
                volume={base * (hasScreenAudio ? streamMul : userMul)}
                muted={deafened && !hasScreenAudio}
              />
            );
          })}

        <div className="absolute top-4 left-4 flex items-center gap-2">
          <div className="px-3 py-1.5 text-xs rounded-full bg-black/60 backdrop-blur border border-white/10 flex items-center gap-1.5">
            <UsersIcon size={14} />
            <span>
              {group?.name || 'Группа'} · {peopleLabel}
            </span>
          </div>
          {pinnedKey && (
            <button
              onClick={() => setPinnedKey(null)}
              className="px-3 py-1.5 text-xs rounded-full bg-black/60 backdrop-blur border border-white/10 flex items-center gap-1.5 hover:bg-black/80"
              title="Открепить и вернуть сетку"
            >
              <PinOff size={14} />
              <span>Открепить</span>
            </button>
          )}
        </div>
      </div>

      <div className="p-4 flex items-center justify-center gap-3 bg-bg-1 border-t border-border">
        <ToolButton
          onClick={toggleMute}
          active={muted}
          activeDanger
          title={muted ? 'Включить микрофон' : 'Выключить микрофон'}
        >
          {muted ? <MicOff size={20} /> : <Mic size={20} />}
        </ToolButton>
        <ToolButton
          onClick={toggleDeafen}
          active={deafened}
          activeDanger
          title={deafened ? 'Включить звук' : 'Заглушить звук (только у вас)'}
        >
          {deafened ? <VolumeX size={20} /> : <Volume2 size={20} />}
        </ToolButton>
        {withVideo && (
          <ToolButton
            onClick={toggleCamera}
            active={cameraOn}
            title={cameraOn ? 'Выключить камеру' : 'Включить камеру'}
          >
            {cameraOn ? <Video size={20} /> : <VideoOff size={20} />}
          </ToolButton>
        )}
        <ToolButton
          onClick={() => {
            if (sharingScreen) toggleScreenShare();
            else setQualityOpen(true);
          }}
          active={sharingScreen}
          title={sharingScreen ? 'Остановить демонстрацию экрана' : 'Начать демонстрацию экрана'}
        >
          {sharingScreen ? <ScreenShareOff size={20} /> : <ScreenShare size={20} />}
        </ToolButton>
        <ToolButton onClick={() => setSettingsOpen(true)} title="Настройки">
          <Settings size={20} />
        </ToolButton>
        <button
          onClick={() => leave()}
          className="btn-icon bg-danger hover:bg-danger-hover text-white ml-2"
          style={{ width: 52, height: 52 }}
          title="Покинуть"
        >
          <PhoneOff size={22} />
        </button>
      </div>

      <Suspense fallback={null}>
        <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      </Suspense>
      <ScreenQualityModal
        open={qualityOpen}
        defaultPreset={settings.screenQuality || '720p'}
        onClose={() => setQualityOpen(false)}
        onConfirm={(preset, includeAudio) => {
          setQualityOpen(false);
          toggleScreenShare(preset, includeAudio);
        }}
      />

      {/* Меню громкости конкретного участника */}
      {streamVolumeMenu &&
        (() => {
          const uid = streamVolumeMenu.userId;
          const u = usersById?.[uid] ||
            group?.members?.find((m) => m.id === uid) || { id: uid, displayName: `#${uid}` };
          const userVolume = settings.userVolumes?.[uid] ?? 100;
          const streamVolume = settings.streamVolumes?.[uid] ?? 100;
          const hasScreenAudio = !!peersMedia?.[uid]?.screenAudio;
          return (
            <>
              <div className="fixed inset-0 z-[89]" onClick={() => setStreamVolumeMenu(null)} />
              <div
                className="fixed z-[90] bg-bg-1 border border-border rounded-lg shadow-xl p-4 w-64"
                style={{ left: streamVolumeMenu.x, top: streamVolumeMenu.y }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium truncate pr-2">
                    Громкость · {getDisplayName(u)}
                  </span>
                  <button
                    onClick={() => setStreamVolumeMenu(null)}
                    className="text-slate-400 hover:text-white"
                    aria-label="Закрыть меню громкости"
                  >
                    <X size={16} />
                  </button>
                </div>
                <label className="block text-xs text-slate-400 mb-1">Пользователь</label>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={userVolume}
                  onChange={(e) => {
                    const nv = Number(e.target.value);
                    update({ userVolumes: { ...(settings.userVolumes || {}), [uid]: nv } });
                  }}
                  className="range w-full"
                  aria-label="Громкость пользователя"
                  style={{ '--range-progress': `${userVolume}%` } as React.CSSProperties}
                />
                <div className="flex justify-between text-xs text-slate-400 mt-1">
                  <span>0%</span>
                  <span>{userVolume}%</span>
                  <span>100%</span>
                </div>
                {hasScreenAudio && (
                  <div className="mt-4">
                    <label className="block text-xs text-slate-400 mb-1">Стрим</label>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={streamVolume}
                      onChange={(e) => {
                        const nv = Number(e.target.value);
                        update({ streamVolumes: { ...(settings.streamVolumes || {}), [uid]: nv } });
                      }}
                      className="range w-full"
                      aria-label="Громкость стрима"
                      style={{ '--range-progress': `${streamVolume}%` } as React.CSSProperties}
                    />
                    <div className="flex justify-between text-xs text-slate-400 mt-1">
                      <span>0%</span>
                      <span>{streamVolume}%</span>
                      <span>100%</span>
                    </div>
                  </div>
                )}
              </div>
            </>
          );
        })()}
    </div>
  );
}

function ToolButton({ onClick, active = false, activeDanger = false, title, children }) {
  const base = 'btn-icon transition-colors';
  const style = active
    ? activeDanger
      ? 'bg-danger hover:bg-danger-hover text-white'
      : 'bg-accent hover:bg-accent-hover text-white'
    : 'bg-bg-3 hover:bg-bg-2 text-slate-100';
  return (
    <button
      onClick={onClick}
      title={title}
      className={`${base} ${style}`}
      style={{ width: 48, height: 48 }}
    >
      {children}
    </button>
  );
}
