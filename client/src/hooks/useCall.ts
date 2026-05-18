import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useSpeakingDetector } from './useSpeakingDetector';
import {
  captureLocalMedia,
  captureDisplay,
  applyVideoSenderQuality,
  createPlaceholderAudioTrack,
  createPlaceholderVideoTrack,
} from '../utils/media';
import {
  createMicPipeline,
  pickAudioFilterSettings,
  createMicScreenMixer,
  type MicScreenMixer,
} from '../utils/audioProcessing';
import { onShortcutEvent, isDesktop } from '../utils/desktop';
import { startRtcDiag, buildRtcConfig } from '../utils/rtcDiag';

/**
 * useCall — один активный звонок между двумя пользователями.
 * Состояния: 'idle' | 'calling' | 'incoming' | 'connecting' | 'in-call' | 'waiting'.
 *
 * 'waiting' — пир временно отключился (закрыл вкладку/нажал hangup),
 * но у нас 5 минут на то, чтобы он вернулся. Мы удерживаем CallView
 * и локальный стрим, тушим только PeerConnection и remote-поток.
 * Как только пир заходит обратно (новый invite), соединение поднимается
 * автоматически без лишних модалок.
 *
 * Сигналинг через Socket.IO. Медиа-состояние пира (микрофон/камера/экран)
 * транслируется отдельными событиями `media:state`, чтобы UI точно знал,
 * нужно показывать видео-плашку или аватарку.
 */
const WAIT_WINDOW_MS = 5 * 60 * 1000;

// SessionStorage-ключ для воскрешения активного звонка после reload'а.
// Храним только в sessionStorage (не localStorage), чтобы данные жили
// строго в рамках одной вкладки и не путали другие сессии. Просрочиваем
// записи старше 5 минут — серверный waiting-window столько же.
const ACTIVE_CALL_STORAGE_KEY = 'owncord.activeCall';
const REJOIN_MAX_AGE_MS = 5 * 60 * 1000;

export function useCall({ socket, selfUser, settings, toast, sounds }) {
  // Refresh-resilience: считываем сохранённый звонок СИНХРОННО ещё до
  // useState'ов, чтобы инициализировать state='waiting' / peer / callId
  // СРАЗУ на маунте. Без этого после F5 пользователь видит idle (CallView
  // возвращает null) и не понимает, что звонок ещё активен на сервере.
  // По фидбеку юзер хотел видеть окно звонка у обоих участников —
  // отключённый теперь синхронно попадает в 'waiting' и видит ту же
  // плашку с двумя аватарками, что и пир.
  const [initialSavedCall] = useState(() => {
    try {
      const raw = sessionStorage.getItem(ACTIVE_CALL_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.peer || typeof parsed.peer.id !== 'number') return null;
      if (Date.now() - (parsed.ts || 0) > REJOIN_MAX_AGE_MS) return null;
      return parsed;
    } catch {
      return null;
    }
  });

  const [state, setState] = useState(initialSavedCall ? 'waiting' : 'idle');
  const [peer, setPeer] = useState(initialSavedCall?.peer || null);
  const [withVideo, setWithVideo] = useState(
    initialSavedCall ? !!initialSavedCall.withVideo : false,
  );
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  // waitingUntil: сколько у нас осталось до того, как сервер сам
  // финализирует звонок. Считаем от saved.ts + 5 мин, не от now (если
  // юзер refreshнул через 1 минуту, должно остаться 4, а не свежие 5).
  const [waitingUntil, setWaitingUntil] = useState(
    initialSavedCall ? (initialSavedCall.ts || Date.now()) + REJOIN_MAX_AGE_MS : null,
  );
  // selfLeft=true — это Я нажал End (должен видеть зелёную «Подключиться»).
  // selfLeft=false — ушёл ПИР, я остался в звонке один и жду его (должен
  // видеть красную End, чтобы тоже уйти и закрыть окно у обоих).
  //
  // НА F5: форсируем selfLeft=true независимо от сохранённого
  // значения. Рефреш разывает socket — сервер видит disconnect,
  // пиру прилетает 'peer-disconnected', т.е. мы фактически вышли
  // из звонка. Чтобы юзер мог вручную переподключиться через
  // зелёную Connect, на хидрации выставляем selfLeft=true.
  // (Раньше selfLeft=false + авто-rejoin работал нестабильно и
  // часто выкидывал из звонка.)
  const [selfLeft, setSelfLeft] = useState(!!initialSavedCall);

  const [muted, setMuted] = useState(false);
  // Локальный «глухой режим»: заставляет наш <audio> НЕ воспроизводить
  // входящий звук. Микрофон продолжает работать — собеседник слышит нас
  // как обычно. На серверной/WebRTC-стороне ничего не меняется. Пиру
  // всё же сообщаем через media:state, чтобы его UI нарисовал иконку
  // «наушники выключены» (Discord-like). deafenedRef — без closure-stale
  // внутри emitMyMedia (он мемоизирован на [socket]).
  const [deafened, setDeafened] = useState(false);
  const deafenedRef = useRef(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [sharingScreen, setSharingScreen] = useState(false);

  // Что пир сейчас шлёт — для UI на нашей стороне.
  const [peerMedia, setPeerMedia] = useState({
    mic: true,
    camera: false,
    screen: false,
    screenAudio: false,
    deafened: false,
  });

  // state-ref для доступа из обработчиков сокета (closures).
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // pc и связанные
  const pcRef = useRef(null);
  const callIdRef = useRef(null);
  const peerRef = useRef(null);
  const iceQueueRef = useRef([]);
  const pendingOfferRef = useRef(null);
  const audioSenderRef = useRef(null);
  const videoSenderRef = useRef(null);
  const iceServersRef = useRef(null);
  // Стоп-функция текущего rtc-diag цикла. Создаётся в createPeerConnection,
  // снимается в enterWaiting/cleanup. Помогает не наплодить параллельных
  // setInterval'ов при реджойне (createPeerConnection вызывается заново).
  const rtcDiagStopRef = useRef<null | (() => void)>(null);
  // Watchdog: если ICE/connection не пришёл в 'connected' за разумное время,
  // принудительно роняем звонок. Без этого мобильные браузеры (Safari iOS,
  // Yandex) могут «висеть» в connecting на симметричном NAT/CGNAT'е без
  // TURN — пользователь видит вечный спиннер «Соединение…».
  const iceTimeoutRef = useRef(null);
  const ICE_CONNECT_TIMEOUT_MS = 45_000;

  // Локальные треки. Микрофон прогоняем через AudioContext-pipeline
  // (HighPass → Compressor → NoiseGate → MakeupGain) — см. utils/audioProcessing.
  // Прошлая версия ходила «сырым» треком, потому что AudioContext в
  // suspended-состоянии после async-цепочки accept→getUserMedia отдавал
  // немой track. Сейчас явно делаем ctx.resume() в createMicPipeline,
  // и проблема не воспроизводится. micTrackRef.current = OUTPUT-трек
  // pipeline'а; toggleMute дёргает .enabled именно у него.
  const localStreamRef = useRef(null);
  const micTrackRef = useRef(null);
  const micPipelineRef = useRef(null);
  const cameraTrackRef = useRef(null);
  const screenTrackRef = useRef(null);
  const screenAudioTrackRef = useRef(null); // Аудио трек из стрима экрана
  // Микшер mic + screen-audio. Живёт ровно столько же, сколько включена
  // демонстрация со звуком: создаётся в toggleScreenShare(includeAudio),
  // ставится на audio-sender, уничтожается при выключении демки/onended.
  // Без него replaceTrack(audioSender, screenAudio) выкидывал бы голос
  // с провода — это и был баг "стрим со звуком ⇒ меня не слышно".
  const micScreenMixerRef = useRef<MicScreenMixer | null>(null);
  // Placeholder-треки, прицепляемые к sender'ам, когда нет реального
  // аудио/видео. Существуют, чтобы SDP сразу содержал msid+ssrc и
  // последующий replaceTrack(realTrack) не требовал renegotiation.
  const placeholderAudioRef = useRef(null);
  const placeholderVideoRef = useRef(null);

  // Загрузка ICE-серверов один раз.
  useEffect(() => {
    let cancelled = false;
    api
      .iceServers()
      .then((cfg) => {
        if (!cancelled) iceServersRef.current = cfg.iceServers;
      })
      .catch(() => {
        if (!cancelled) iceServersRef.current = [{ urls: 'stun:stun.l.google.com:19302' }];
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // --- Утилиты -----------------------------------------------------------
  const setLocal = useCallback((stream) => {
    localStreamRef.current = stream;
    setLocalStream(stream);
  }, []);

  // Текущее состояние "моих" медиа (для emit) — считается на лету.
  // Источник истины — сами треки/sender'ы, а не React-state, иначе
  // emitMyMedia, мемоизированный через useCallback([socket]), читал бы
  // muted из устаревшего closure'а первого рендера.
  const getMyMediaState = () => ({
    mic: !!micTrackRef.current && !!micTrackRef.current.enabled,
    camera: !!cameraTrackRef.current && videoSenderRef.current?.track === cameraTrackRef.current,
    screen: !!screenTrackRef.current && videoSenderRef.current?.track === screenTrackRef.current,
    screenAudio: !!screenAudioTrackRef.current,
    deafened: deafenedRef.current,
  });

  const emitMyMedia = useCallback(() => {
    if (!peerRef.current || !callIdRef.current || !socket) return;
    socket.emit('media:state', {
      to: peerRef.current.id,
      callId: callIdRef.current,
      state: getMyMediaState(),
    });
  }, [socket]);

  const cleanup = useCallback(
    (reason) => {
      if (reason) sounds?.playDisconnect?.();
      sounds?.stopIncoming?.();
      sounds?.stopOutgoing?.();

      // Снимаем watchdog ICE — иначе он может выстрелить на уже закрытом PC.
      if (iceTimeoutRef.current) {
        clearTimeout(iceTimeoutRef.current);
        iceTimeoutRef.current = null;
      }
      if (rtcDiagStopRef.current) {
        try {
          rtcDiagStopRef.current();
        } catch {
          /* */
        }
        rtcDiagStopRef.current = null;
      }

      try {
        if (pcRef.current) {
          pcRef.current.ontrack = null;
          pcRef.current.onicecandidate = null;
          pcRef.current.onconnectionstatechange = null;
          pcRef.current.oniceconnectionstatechange = null;
          pcRef.current.close();
        }
      } catch {
        /* ignore */
      }
      pcRef.current = null;
      iceQueueRef.current = [];
      audioSenderRef.current = null;
      videoSenderRef.current = null;
      callIdRef.current = null;
      peerRef.current = null;
      pendingOfferRef.current = null;

      const ls = localStreamRef.current;
      if (ls)
        ls.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {
            /* */
          }
        });
      localStreamRef.current = null;

      // Pipeline сам остановит свои raw-треки и закроет AudioContext.
      // Делаем это ДО обнуления micTrackRef, чтобы destroy() мог дёрнуть
      // outputTrack.stop() — иначе выходной трек MediaStreamDestination
      // может остаться висеть.
      if (micPipelineRef.current) {
        try {
          micPipelineRef.current.destroy();
        } catch {
          /* */
        }
        micPipelineRef.current = null;
      }
      // Микшер mic+screen-audio (если демка со звуком была активна на
      // момент завершения звонка) — закрываем свой AudioContext и
      // outputTrack, чтобы не утекали ресурсы.
      if (micScreenMixerRef.current) {
        try {
          micScreenMixerRef.current.destroy();
        } catch {
          /* */
        }
        micScreenMixerRef.current = null;
      }

      for (const ref of [
        cameraTrackRef,
        screenTrackRef,
        micTrackRef,
        placeholderAudioRef,
        placeholderVideoRef,
      ]) {
        if (ref.current) {
          try {
            ref.current.stop();
          } catch {
            /* */
          }
          ref.current = null;
        }
      }

      setLocalStream(null);
      setRemoteStream(null);
      setPeer(null);
      setMuted(false);
      setDeafened(false);
      deafenedRef.current = false;
      setCameraOn(false);
      setSharingScreen(false);
      setWithVideo(false);
      setPeerMedia({
        mic: true,
        camera: false,
        screen: false,
        screenAudio: false,
        deafened: false,
      });
      setWaitingUntil(null);
      setSelfLeft(false);
      setState('idle');
    },
    [sounds],
  );

  // Перевод в состояние "ждём собеседника": пир ушёл, но у нас 5 минут,
  // чтобы он вернулся. Не трогаем локальные треки (микрофон/камера),
  // чтобы при возврате не перевыбирать устройства.
  //
  // `bySelf` — это МЫ сами только что нажали End (true) или ушёл ПИР
  // (false). UI по этому флагу решает, какую кнопку показать:
  //   leaver          → зелёная «Подключиться» (rejoinAsCaller)
  //   оставшийся один → красная End (hangup → cleanup; сервер финалит)
  const enterWaiting = useCallback(
    (bySelf = false) => {
      if (iceTimeoutRef.current) {
        clearTimeout(iceTimeoutRef.current);
        iceTimeoutRef.current = null;
      }
      if (rtcDiagStopRef.current) {
        try {
          rtcDiagStopRef.current();
        } catch {
          /* */
        }
        rtcDiagStopRef.current = null;
      }
      try {
        if (pcRef.current) {
          pcRef.current.ontrack = null;
          pcRef.current.onicecandidate = null;
          pcRef.current.onconnectionstatechange = null;
          pcRef.current.oniceconnectionstatechange = null;
          pcRef.current.close();
        }
      } catch {
        /* ignore */
      }
      pcRef.current = null;
      iceQueueRef.current = [];
      audioSenderRef.current = null;
      videoSenderRef.current = null;
      pendingOfferRef.current = null;
      setRemoteStream(null);
      setPeerMedia({
        mic: false,
        camera: false,
        screen: false,
        screenAudio: false,
        deafened: false,
      });
      setWaitingUntil(Date.now() + WAIT_WINDOW_MS);
      setSelfLeft(bySelf);
      setState('waiting');
      sounds?.playDisconnect?.();
    },
    [sounds],
  );

  // --- PeerConnection ----------------------------------------------------
  // Создание PeerConnection построено по классической схеме:
  //   1) создаём pc;
  //   2) НА ОБЕИХ сторонах сразу addTrack() для имеющихся локальных треков,
  //      что гарантирует direction='sendrecv' и наличие msid в SDP;
  //   3) если video-трека нет (звонок без камеры), всё равно создаём
  //      пустой sendrecv video-transceiver — так screen-share/camera toggle
  //      позже сможет просто replaceTrack() без renegotiation.
  // ВАЖНО: вызывать createPeerConnection ТОЛЬКО ПОСЛЕ того, как локальные
  // треки захвачены (await getLocalMedia()) — иначе addTrack нечего будет
  // прикреплять и связь пойдёт в одну сторону.
  const createPeerConnection = useCallback(
    (_role) => {
      const pc = new RTCPeerConnection(
        buildRtcConfig(iceServersRef.current, {
          forceTurnRelay: !!settings?.forceTurnRelay,
        }),
      );
      pcRef.current = pc;
      // Снимаем предыдущий diag-цикл, если был (реджойн внутри той же сессии).
      if (rtcDiagStopRef.current) {
        try {
          rtcDiagStopRef.current();
        } catch {
          /* */
        }
        rtcDiagStopRef.current = null;
      }
      rtcDiagStopRef.current = startRtcDiag(pc, 'dm');

      // ontrack/onice/onstate ставим ДО addTrack — на старых браузерах
      // addTrack может синхронно срабатывать как изменение состояния.
      pc.ontrack = (ev) => {
        setRemoteStream((prev) => {
          const set = new Set<MediaStreamTrack>(prev ? prev.getTracks() : []);
          const before = set.size;
          if (ev.streams[0]) {
            for (const t of ev.streams[0].getTracks()) set.add(t);
          } else {
            set.add(ev.track);
          }
          // Если набор треков не изменился — не пересоздаём MediaStream,
          // чтобы лишний раз не дёргать srcObject/play() в RemoteAudio.
          if (prev && set.size === before) return prev;
          return new MediaStream([...set]);
        });
      };

      pc.onicecandidate = (ev) => {
        if (ev.candidate && peerRef.current && callIdRef.current) {
          socket.emit('rtc:ice', {
            to: peerRef.current.id,
            callId: callIdRef.current,
            candidate: ev.candidate,
          });
        }
      };

      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected') {
          // Соединение установлено — снимаем watchdog, чтобы он не сработал
          // на гипотетическом подвисании после рестарта ICE.
          if (iceTimeoutRef.current) {
            clearTimeout(iceTimeoutRef.current);
            iceTimeoutRef.current = null;
          }
          setState('in-call');
          sounds?.stopOutgoing?.();
          sounds?.stopIncoming?.();
          sounds?.playConnect?.();
          emitMyMedia();
        }
        if (s === 'failed' || s === 'closed') {
          if (iceTimeoutRef.current) {
            clearTimeout(iceTimeoutRef.current);
            iceTimeoutRef.current = null;
          }
          hangup('connection-failed');
        }
      };

      // Дублируем как iceconnectionstatechange — на старых Chromium-движках
      // (Yandex 22-23, некоторые WebView) connectionState не апдейтится
      // вовсе, и единственный сигнал перехода — это ICE-state.
      pc.oniceconnectionstatechange = () => {
        const s = pc.iceConnectionState;
        if ((s === 'connected' || s === 'completed') && iceTimeoutRef.current) {
          clearTimeout(iceTimeoutRef.current);
          iceTimeoutRef.current = null;
          // Если основной pc.connectionState не двинулся — двигаем UI вручную.
          if (pc.connectionState !== 'connected') {
            setState((prev) => (prev === 'connecting' || prev === 'calling' ? 'in-call' : prev));
          }
        }
        if (s === 'failed' && iceTimeoutRef.current) {
          clearTimeout(iceTimeoutRef.current);
          iceTimeoutRef.current = null;
          toast?.error?.(
            'Не удалось установить P2P-соединение. Возможно, ваша сеть требует TURN-сервер. Попробуйте сменить Wi-Fi или браузер.',
          );
          hangup('ice-failed');
        }
      };

      // Если за 45 секунд PeerConnection не дошёл до 'connected' — роняем
      // звонок и сообщаем пользователю про NAT/TURN. Это ровно тот случай,
      // когда мобильный браузер «висит на коннекте» бесконечно.
      if (iceTimeoutRef.current) {
        clearTimeout(iceTimeoutRef.current);
      }
      iceTimeoutRef.current = setTimeout(() => {
        iceTimeoutRef.current = null;
        if (pcRef.current !== pc) return;
        const cs = pc.connectionState;
        const ics = pc.iceConnectionState;
        if (cs === 'connected' || ics === 'connected' || ics === 'completed') return;
        toast?.error?.(
          'Соединение не установлено за 45 секунд. Возможно, требуется TURN-сервер или другая сеть (мобильные операторы и Яндекс.Браузер часто блокируют прямое P2P).',
        );
        hangup('ice-timeout');
      }, ICE_CONNECT_TIMEOUT_MS);

      // КЛЮЧЕВОЕ: addTrack() ВСЕГДА с реальным MediaStreamTrack — даже если
      // у пользователя нет камеры или (теоретически) микрофона. Если трека
      // нет, прицепляем placeholder. Это даёт SDP с msid+ssrc с первого
      // обмена, и последующий replaceTrack(realTrack) для toggleCamera /
      // toggleScreenShare работает БЕЗ renegotiation, а пир сразу видит
      // через ontrack живой stream.
      //
      // Раньше для отсутствующего видео мы создавали пустой sendrecv-
      // transceiver — Chrome в этом случае не fire-ил ontrack у пира при
      // последующем replaceTrack, и демонстрация экрана от callee не была
      // видна caller'у. Placeholder этот сценарий полностью закрывает.
      const ls = localStreamRef.current;
      const micTrack = micTrackRef.current;
      const videoTrack = screenTrackRef.current || cameraTrackRef.current || null;

      let audioForSender = micTrack;
      if (!audioForSender) {
        if (!placeholderAudioRef.current) {
          placeholderAudioRef.current = createPlaceholderAudioTrack();
        }
        audioForSender = placeholderAudioRef.current;
      }
      audioSenderRef.current = pc.addTrack(audioForSender, ls || new MediaStream([audioForSender]));

      let videoForSender = videoTrack;
      if (!videoForSender) {
        if (!placeholderVideoRef.current) {
          placeholderVideoRef.current = createPlaceholderVideoTrack();
        }
        videoForSender = placeholderVideoRef.current;
      }
      videoSenderRef.current = pc.addTrack(videoForSender, ls || new MediaStream([videoForSender]));

      return pc;
    },
    [emitMyMedia, socket, sounds, settings?.forceTurnRelay],
  );

  // --- Локальный медиа-стрим --------------------------------------------
  // Захват микрофона/камеры. Микрофон прогоняем через AudioContext-pipeline
  // (HighPass → Compressor → NoiseGate → MakeupGain). AudioContext явно
  // резюмируется внутри createMicPipeline, поэтому проблемы «немого трека»
  // больше нет. На PC уходит processed-track из MediaStreamDestination.
  const getLocalMedia = useCallback(
    async (wantVideo) => {
      // Берём raw-стрим с echoCancellation/noiseSuppression/AGC от браузера —
      // эти три флага мы НЕ дублируем в нашей цепочке: их реализация в
      // браузере существенно лучше любого Web Audio наколеночного варианта.
      const rawStream = await captureLocalMedia({
        wantVideo,
        audioDeviceId: settings.inputDeviceId,
      });

      const rawMic = rawStream.getAudioTracks()[0] || null;
      const videoTrack = rawStream.getVideoTracks()[0] || null;

      let micTrack = rawMic;
      // В Electron-десктопе всегда обходим AudioContext-pipeline для
      // RTC-sender'а: даже если ctx в 'running'-state, RTCRtpSender
      // энкодит трек от MediaStreamDestination в тишину (известный
      // квикс Chromium-в-Electron, см. utils/media.ts:86 — эту же
      // проблему уже ловили в прошлом). Локальный тест микро через
      // тот же pipeline работает, потому что он играет outputStream
      // через <audio>, минуя RTP-конвейер. На вебе же RTC корректно
      // обрабатывает такие треки, поэтому pipeline остаётся включённым
      // (его убирает только тогл «Применять фильтры микрофона»).
      // Цена: в десктопе кастомные OBS-style фильтры (HighPass /
      // Compressor / Gate / MakeupGain) не применяются — звук идёт
      // сырой, но с нативной обработкой Chromium (echoCancellation /
      // noiseSuppression / autoGainControl), которая по качеству
      // близка к NS3 от Google и для голосового чата более чем хватает.
      const wantPipeline = rawMic && settings?.audioFiltersEnabled !== false && !isDesktop();
      if (wantPipeline) {
        try {
          const pipeline = await createMicPipeline(
            new MediaStream([rawMic]),
            pickAudioFilterSettings(settings),
          );
          // Дать AudioContext ~150 мс на стабилизацию после resume().
          // Если он остался suspended (Electron теряет user-activation
          // на async-цепочке getUserMedia → ctx.resume() уходит в void),
          // MediaStreamDestination отдаёт «немой» track и пир слышит
          // тишину. В таком случае честнее откатиться на raw, чем
          // пускать в RTC заведомо мёртвый трек.
          await new Promise((resolve) => setTimeout(resolve, 150));
          if (pipeline.context.state !== 'running') {
            console.warn(
              '[useCall] mic pipeline AudioContext не запустился (state=',
              pipeline.context.state,
              ') — fallback на сырой mic-трек',
            );
            try {
              pipeline.destroy();
            } catch {
              /* */
            }
            micTrack = rawMic;
          } else {
            micPipelineRef.current = pipeline;
            micTrack = pipeline.outputTrack;
          }
        } catch (e) {
          // Fallback: если что-то сломалось при сборке pipeline (ноды/ctx),
          // отдаём сырой трек, чтобы звонок всё-таки прошёл. Это лучше,
          // чем «немой» вызов без диагностики.
          console.warn('Mic pipeline failed, falling back to raw track:', e);
          micTrack = rawMic;
        }
      }

      micTrackRef.current = micTrack;
      if (videoTrack) cameraTrackRef.current = videoTrack;

      const outStream = new MediaStream();
      if (micTrack) outStream.addTrack(micTrack);
      if (videoTrack) outStream.addTrack(videoTrack);
      setLocal(outStream);
      if (videoTrack) setCameraOn(true);
      return { micTrack, videoTrack };
    },
    [setLocal, settings],
  );

  // Прокидываем изменения настроек фильтров в живой pipeline без пересборки.
  // Если pipeline'а нет (вне звонка) — useEffect просто ничего не делает.
  useEffect(() => {
    const pipeline = micPipelineRef.current;
    if (!pipeline) return;
    try {
      pipeline.updateSettings(pickAudioFilterSettings(settings));
    } catch {
      /* ignore */
    }
  }, [
    settings.inputVolume,
    settings.noiseSuppression,
    settings.noiseThreshold,
    settings.noiseGateHoldMs,
    settings.noiseGateAttackMs,
    settings.noiseGateReleaseMs,
    settings.highPassFilter,
    settings.highPassFrequency,
    settings.compressorEnabled,
    settings.compressorThreshold,
    settings.compressorRatio,
    settings.compressorAttack,
    settings.compressorRelease,
    settings.compressorKnee,
    settings.makeupGainDb,
  ]);

  // --- Live mic-swap ---------------------------------------------------
  // Раньше смена `inputDeviceId` или `audioFiltersEnabled` во время активного
  // звонка применялась только к СЛЕДУЮЩЕМУ звонку — текущий продолжал
  // вещать со старого микрофона/без фильтров. Теперь делаем «горячую»
  // замену: новый getUserMedia → (опционально) новый pipeline →
  // replaceTrack у audio sender'а → стоп старого. Если активна демонстрация
  // экрана со звуком, mic+screen микшер пересобирается с новым mic'ом и
  // ставится на sender вместо чистого мика — иначе пир потеряет либо
  // голос, либо звук стрима.
  //
  // Срабатывает только когда в активном звонке (есть pcRef и audio sender).
  // Вне звонка (idle/incoming/waiting) — следующий start() сам подхватит
  // свежие settings через getLocalMedia.
  const swappingMicRef = useRef(false);
  useEffect(() => {
    const pc = pcRef.current;
    const sender = audioSenderRef.current;
    if (!pc || !sender) return undefined;
    const curState = stateRef.current;
    // 'incoming' — мы ещё не приняли (нет своих треков). 'waiting' — pc снят.
    if (curState === 'idle' || curState === 'incoming' || curState === 'waiting') {
      return undefined;
    }
    let cancelled = false;

    (async () => {
      // Если уже идёт swap (быстрая повторная смена) — текущий useEffect
      // отработает позже сам через cancelled-проверку. Не плодим параллельные
      // getUserMedia на одном устройстве.
      if (swappingMicRef.current) return;
      swappingMicRef.current = true;
      try {
        // 1) Свежий raw mic c новым deviceId. Видео не трогаем — у звонка
        //    может быть камера/демка, их свопить не нужно.
        const rawStream = await captureLocalMedia({
          wantVideo: false,
          audioDeviceId: settings.inputDeviceId,
        });
        if (cancelled) {
          rawStream.getTracks().forEach((t) => {
            try {
              t.stop();
            } catch {
              /* */
            }
          });
          return;
        }
        const newRawMic = rawStream.getAudioTracks()[0] || null;
        if (!newRawMic) return;

        // Сохраняем mute-state и проставим его на новом треке: иначе
        // нажатый mute «отвалится» в момент свопа.
        const wasEnabled = micTrackRef.current?.enabled ?? true;

        // 2) Pipeline (web only). На десктопе всегда обходим — см. подробный
        //    комментарий в getLocalMedia выше.
        let newProcessedMic: MediaStreamTrack = newRawMic;
        let newPipeline: any = null;
        const wantPipeline = settings?.audioFiltersEnabled !== false && !isDesktop();
        if (wantPipeline) {
          try {
            const pipeline = await createMicPipeline(
              new MediaStream([newRawMic]),
              pickAudioFilterSettings(settings),
            );
            await new Promise((resolve) => setTimeout(resolve, 150));
            if (cancelled) {
              try {
                pipeline.destroy();
              } catch {
                /* */
              }
              try {
                newRawMic.stop();
              } catch {
                /* */
              }
              return;
            }
            if (pipeline.context.state === 'running') {
              newPipeline = pipeline;
              newProcessedMic = pipeline.outputTrack;
            } else {
              console.warn(
                '[useCall] mic swap pipeline ctx не запустился — fallback на raw',
              );
              try {
                pipeline.destroy();
              } catch {
                /* */
              }
            }
          } catch (e) {
            console.warn('[useCall] swap: pipeline build failed, raw fallback:', e);
          }
        }
        newProcessedMic.enabled = wasEnabled;

        // 3) Если активна демка со звуком — пересобираем mic+screen микшер
        //    с новым mic'ом. Иначе на sender'е останется output старого
        //    микшера, который держит ссылку на убитый raw mic.
        let newMixer: MicScreenMixer | null = null;
        let trackForSender: MediaStreamTrack = newProcessedMic;
        if (micScreenMixerRef.current && screenAudioTrackRef.current) {
          try {
            newMixer = createMicScreenMixer({
              micTrack: newProcessedMic,
              screenAudioTrack: screenAudioTrackRef.current,
            });
            trackForSender = newMixer.outputTrack;
          } catch (e) {
            console.warn('[useCall] swap: mixer rebuild failed:', e);
            // Без миксера пир не услышит screen-audio, но услышит наш голос.
          }
        }

        // 4) Replace track на sender'е. Если упало — откатываем новые ресурсы.
        try {
          await sender.replaceTrack(trackForSender);
        } catch (e) {
          console.warn('[useCall] swap: replaceTrack failed:', e);
          try {
            newPipeline?.destroy();
          } catch {
            /* */
          }
          try {
            newMixer?.destroy();
          } catch {
            /* */
          }
          try {
            newRawMic.stop();
          } catch {
            /* */
          }
          return;
        }
        if (cancelled) {
          // Если useEffect перезапустился, пока мы ждали replaceTrack —
          // следующий проход подменит трек ещё раз; этот выкидываем.
          try {
            newPipeline?.destroy();
          } catch {
            /* */
          }
          try {
            newMixer?.destroy();
          } catch {
            /* */
          }
          try {
            newRawMic.stop();
          } catch {
            /* */
          }
          return;
        }

        // 5) Демонтаж старого. Pipeline.destroy() гасит свой rawStream и
        //    outputTrack — не надо их отдельно стопать. Если pipeline'а не
        //    было, явно стопаем старый mic-трек.
        const oldMicTrack = micTrackRef.current;
        const oldPipeline = micPipelineRef.current;
        const oldMixer = micScreenMixerRef.current;
        try {
          if (oldPipeline) oldPipeline.destroy();
          else if (oldMicTrack && oldMicTrack !== newProcessedMic) oldMicTrack.stop();
        } catch {
          /* */
        }
        if (oldMixer && oldMixer !== newMixer) {
          try {
            oldMixer.destroy();
          } catch {
            /* */
          }
        }

        // 6) Обновляем refs и localStream (для UI: speaking detector, метр).
        micTrackRef.current = newProcessedMic;
        micPipelineRef.current = newPipeline;
        micScreenMixerRef.current = newMixer;

        const ls = localStreamRef.current;
        if (ls) {
          for (const t of ls.getAudioTracks()) {
            if (t !== newProcessedMic) {
              try {
                ls.removeTrack(t);
              } catch {
                /* */
              }
            }
          }
          try {
            ls.addTrack(newProcessedMic);
          } catch {
            /* track уже добавлен — ок */
          }
          setLocal(new MediaStream(ls.getTracks()));
        }

        // Сообщаем пиру актуальное состояние mic (на случай если до
        // свопа было muted — бывает важно для индикатора у пира).
        setTimeout(emitMyMedia, 0);
      } catch (e) {
        console.warn('[useCall] swapMicrophone failed:', e);
        toast?.error?.('Не удалось применить новые настройки микрофона');
      } finally {
        swappingMicRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.inputDeviceId, settings.audioFiltersEnabled]);

  // applyLocalTracks больше не нужен — createPeerConnection сам подвязывает
  // треки через addTrack/addTransceiver. Оставлено как явный no-op-маркер.

  // --- Завершение --------------------------------------------------------
  //
  // "Мягкий" hangup (кнопка End во время установленного разговора, либо
  // без указания reason) не убивает окно звонка — переводит ЛОКАЛЬНОГО
  // пользователя в 'waiting' аналогично тому, как это происходит, когда
  // уходит пир. Это совпадает с требованием юзера: «окно должно
  // оставаться, чтобы через него можно было переподключиться, а не
  // только через плашку в чате». Второй End-клик уже из waiting → полный
  // cleanup (state != established, идём в else-ветку).
  //
  // "Жёсткие" reasons (ice-failed, connection-failed, ice-timeout,
  // offer-failed, answer-failed, start-failed, rejoin-failed,
  // waiting-expired) и хангап из calling/incoming (вызов не состоялся) —
  // сразу закрывают всё. Серверу в любом случае шлём call:end: для
  // established-звонка он пометит call как waiting и разошлёт пиру
  // reason='peer-leaving' (пир тоже увидит waiting-окно), для waiting —
  // финализирует и разошлёт финальный call:end.
  const hangup = useCallback(
    (reason) => {
      const cid = callIdRef.current;
      const target = peerRef.current;
      const wasActive = !!cid && !!target;
      const curState = stateRef.current;
      if (wasActive && socket) {
        socket.emit('call:end', { to: target.id, callId: cid, reason });
      }
      const softReason = !reason || reason === 'hangup';
      const established = curState === 'in-call' || curState === 'connecting';
      if (softReason && established) {
        enterWaiting(true); // это МЫ ушли → зелёная Connect у нас
      } else {
        cleanup('hangup');
      }
    },
    [cleanup, enterWaiting, socket],
  );

  // --- Исходящий вызов ---------------------------------------------------
  const start = useCallback(
    async (targetUser, { withVideo: wantVideo = false } = {}) => {
      // Допускаем 2 точки входа: idle → новый исходящий звонок; waiting →
      // реджойн (например, после F5 у того, кто в звонке был, или когда
      // пир ушёл и сервер на пять минут дал шанс вернуться). Сервер на
      // call:invite сам найдёт существующий waiting-звонок между парой
      // и рекомпонует его (см. server/src/socket.js → call:invite handler
      // → rebindForRejoin). Так не плодим новые DB-записи для каждого
      // F5 и сохраняем длительность начатого разговора.
      if (state !== 'idle' && state !== 'waiting') return;
      const isRejoin = state === 'waiting';
      const callId = `${selfUser.id}-${targetUser.id}-${Date.now()}`;
      callIdRef.current = callId;
      peerRef.current = targetUser;
      setPeer(targetUser);
      setWithVideo(wantVideo);
      // При реджойне — НЕ играем outgoing-звонок и НЕ показываем
      // 'calling' (это для свежего исходящего вызова). Сразу
      // 'connecting' — пир уже знает про звонок и сервер мгновенно
      // рассылает invite дальше через rebindForRejoin.
      if (isRejoin) {
        setWaitingUntil(null);
        setState('connecting');
      } else {
        setState('calling');
        sounds?.startOutgoing?.();
      }

      try {
        // Сначала захватываем медиа (после F5 localStream был null —
        // обязательно), потом создаём PC. createPeerConnection сразу
        // прицепит треки к sender'ам и SDP офера содержал msid.
        await getLocalMedia(wantVideo);
        const pc = createPeerConnection('caller');

        socket.emit('call:invite', { to: targetUser.id, callId, withVideo: wantVideo });

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('rtc:offer', { to: targetUser.id, callId, sdp: pc.localDescription });
      } catch (e) {
        toast?.error?.(
          prettyMediaError(
            isRejoin ? 'Не удалось переподключиться' : 'Не удалось начать звонок',
            e,
          ),
        );
        hangup('start-failed');
      }
    },
    [createPeerConnection, getLocalMedia, hangup, selfUser, socket, sounds, state, toast],
  );

  // --- Реджойн из waiting в роли инициатора -----------------------------
  // Используется кнопкой «Подключиться» у того, кто остался ждать. Создаёт
  // новый callId и шлёт обычный invite + offer. На стороне пира, если он в
  // состоянии waiting к нам, onInvite авто-примет; если в idle — увидит
  // обычный входящий звонок. Локальные треки переиспользуем — мы их при
  // переходе в waiting не трогали.
  const rejoinAsCaller = useCallback(async () => {
    if (stateRef.current !== 'waiting') return;
    const target = peerRef.current;
    if (!target) return;
    const newCallId = `${selfUser.id}-${target.id}-${Date.now()}`;
    callIdRef.current = newCallId;
    setWaitingUntil(null);
    setSelfLeft(false);
    // При реджойне не играем outgoing-рингтон: пир уже знает про звонок
    // (он в waiting), и длинный исходящий гудок тут не в тему. Короткий
    // connect/disconnect-звук (см. sounds.playConnect/playDisconnect)
    // остаётся — он триггерится из PC-коллбеков при реальном connected.
    // Состояние сразу 'connecting' (а не 'calling'), как и в start()
    // на isRejoin-ветке.
    setState('connecting');

    try {
      // Локальные треки в waiting не уничтожались — createPeerConnection
      // сразу прицепит их через addTrack из refs.
      const pc = createPeerConnection('caller');

      socket.emit('call:invite', { to: target.id, callId: newCallId, withVideo });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('rtc:offer', { to: target.id, callId: newCallId, sdp: pc.localDescription });
    } catch (e) {
      toast?.error?.(prettyMediaError('Не удалось переподключиться', e));
      cleanup('rejoin-failed');
    }
  }, [createPeerConnection, cleanup, selfUser, socket, sounds, toast, withVideo]);

  // --- Входящий вызов — принять ------------------------------------------
  const accept = useCallback(async () => {
    if (state !== 'incoming') return;
    sounds?.stopIncoming?.();
    setState('connecting');
    try {
      // ВАЖНЫЙ ПОРЯДОК: сначала захватываем медиа, потом создаём PC.
      // createPeerConnection сам прицепит треки из refs к sender'ам, поэтому
      // даже если rtc:offer прилетит между ними, в onOffer уже не нужно
      // ждать и track будет в SDP answer-а.
      await getLocalMedia(withVideo);

      const pc = createPeerConnection('callee');
      socket.emit('call:accept', { to: peerRef.current.id, callId: callIdRef.current });

      const pending = pendingOfferRef.current;
      if (pending) {
        pendingOfferRef.current = null;
        await pc.setRemoteDescription(pending);
        // Senders уже инициализированы и привязаны к трекам внутри
        // createPeerConnection. Доп. applyLocalTracks тут не нужен.
        for (const c of iceQueueRef.current) {
          try {
            await pc.addIceCandidate(c);
          } catch {
            /* */
          }
        }
        iceQueueRef.current = [];
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('rtc:answer', {
          to: peerRef.current.id,
          callId: callIdRef.current,
          sdp: pc.localDescription,
        });
      }
      // Если pending нет — onOffer обработает позже. PC и треки уже готовы.
    } catch (e) {
      toast?.error?.(prettyMediaError('Не удалось принять звонок', e));
      hangup('accept-failed');
    }
  }, [createPeerConnection, getLocalMedia, hangup, socket, sounds, state, toast, withVideo]);

  const reject = useCallback(() => {
    if (state !== 'incoming') return;
    sounds?.stopIncoming?.();
    if (peerRef.current && callIdRef.current) {
      socket.emit('call:reject', { to: peerRef.current.id, callId: callIdRef.current });
    }
    cleanup(undefined);
  }, [cleanup, socket, sounds, state]);

  // --- Переключения медиа -----------------------------------------------
  const toggleMute = useCallback(() => {
    const track = micTrackRef.current;
    if (!track) return;
    const nextEnabled = !track.enabled;
    track.enabled = nextEnabled;
    setMuted(!nextEnabled);
    // Пип перед emitMyMedia — пользователь должен услышать фидбек
    // мгновенно, независимо от задержки сети.
    if (nextEnabled) sounds?.playMicUnmute?.();
    else sounds?.playMicMute?.();
    // emit отправим после setMuted
    setTimeout(emitMyMedia, 0);
  }, [emitMyMedia, sounds]);

  // Локальный «мьют наушников» — просто тумблер. Применяется в UI через
  // <audio muted={deafened}> без затрагивания входящего трека, поэтому
  // ре-подписывания WebRTC не требуется.
  const toggleDeafen = useCallback(() => {
    const next = !deafenedRef.current;
    deafenedRef.current = next;
    setDeafened(next);
    // Играем ДО того, как state применится — но сами звуки идут через
    // отдельный AudioContext useSounds, не через тот <audio>, который
    // мы сейчас замьютим; так что пользователь услышит их даже если
    // включается deafen. Это ожидаемое поведение: UI-пип — не «звук
    // собеседника», его глушить deafen'ом не надо.
    if (next) sounds?.playDeafen?.();
    else sounds?.playUndeafen?.();
    // Сообщаем пиру — он покажет иконку «наушники выключены» у нашей
    // аватарки. WebRTC-трафик никак не меняется — просто сигналинг.
    setTimeout(emitMyMedia, 0);
  }, [emitMyMedia, sounds]);

  // Глобальные хоткеи десктопа (Electron globalShortcut). Срабатывают
  // даже когда окно OwnCord не в фокусе — для этого мы тут вешаемся
  // на DOM-event 'owncord:shortcut', который шлёт preload.js. На вебе
  // событие никогда не прилетит — onShortcutEvent сам no-op'ом.
  //
  // ВАЖНО: подписываемся ТОЛЬКО когда мы в активной фазе звонка. Иначе
  // toggleDeafen всё равно переключает deafenedRef/setDeafened (у него нет
  // трекового гейта, как у toggleMute), и в idle/incoming юзер ловит
  // фантомный «глухой режим». 'connecting' и 'waiting' оставляем — там
  // mic-track ещё/уже жив и hotkey должен работать.
  useEffect(() => {
    if (state !== 'in-call' && state !== 'connecting' && state !== 'waiting') {
      return undefined;
    }
    return onShortcutEvent((action) => {
      if (action === 'toggleMute') toggleMute();
      else if (action === 'toggleDeafen') toggleDeafen();
    });
  }, [toggleMute, toggleDeafen, state]);

  const turnOffVideoSender = useCallback(async () => {
    if (!videoSenderRef.current) return;
    // Возвращаем placeholder, чтобы sender имел валидный track —
    // canale RTP остаётся живым, и при следующем включении камеры/демки
    // у пира не возникнет проблем с обновлением streams.
    if (!placeholderVideoRef.current) {
      placeholderVideoRef.current = createPlaceholderVideoTrack();
    }
    try {
      await videoSenderRef.current.replaceTrack(placeholderVideoRef.current);
    } catch {
      /* */
    }
  }, []);

  const toggleCamera = useCallback(async () => {
    if (!pcRef.current || !videoSenderRef.current) return;

    // Если сейчас стримим экран — сначала выключим его
    if (sharingScreen && screenTrackRef.current) {
      try {
        screenTrackRef.current.stop();
      } catch {
        /* */
      }
      screenTrackRef.current = null;
      setSharingScreen(false);
    }

    if (cameraOn && cameraTrackRef.current) {
      // выключить камеру
      try {
        cameraTrackRef.current.stop();
      } catch {
        /* */
      }
      const s = localStreamRef.current;
      if (s) s.removeTrack(cameraTrackRef.current);
      cameraTrackRef.current = null;
      setLocal(new MediaStream(s ? s.getTracks() : []));
      await turnOffVideoSender();
      setCameraOn(false);
      setTimeout(emitMyMedia, 0);
      return;
    }

    try {
      const cam = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      });
      const track = cam.getVideoTracks()[0];
      cameraTrackRef.current = track;
      const s = localStreamRef.current || new MediaStream();
      s.addTrack(track);
      setLocal(new MediaStream(s.getTracks()));
      await videoSenderRef.current.replaceTrack(track);
      setCameraOn(true);
      setTimeout(emitMyMedia, 0);
    } catch (e) {
      const msg = prettyMediaError('Не удалось включить камеру', e);
      toast?.error?.(msg);
    }
  }, [cameraOn, emitMyMedia, setLocal, sharingScreen, toast, turnOffVideoSender]);

  // Renegotiation — после replaceTrack(real) для screen-share. Без неё
  // у пира остаются параметры encoder'а от placeholder (мелкое разрешение,
  // низкий битрейт), и картинка идёт «мылом». Renegotiation также вынуждает
  // sender отправить keyframe, что снимает чёрный экран у пира.
  const renegotiate = useCallback(async () => {
    const pc = pcRef.current;
    const target = peerRef.current;
    const cid = callIdRef.current;
    if (!pc || !target || !cid) return;
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('rtc:offer', { to: target.id, callId: cid, sdp: pc.localDescription });
    } catch {
      /* */
    }
  }, [socket]);

  const toggleScreenShare = useCallback(
    async (presetKey = '720p', includeAudio = false) => {
      if (!pcRef.current || !videoSenderRef.current) return;

      if (sharingScreen && screenTrackRef.current) {
        // Выключаем шаринг экрана.
        //
        // Захватываем треки в локалы и обнуляем ref'ы ДО любых await: иначе
        // .stop() ниже асинхронно фаерит ended на screenTrackRef.current,
        // и пока мы yield-им внутри replaceTrack, наш собственный onended
        // может пойти параллельно по тому же ref'у (двойная очистка → NPE
        // на s.removeTrack(null)). Race-protection в onended построена на
        // проверке screenTrackRef.current !== track — поэтому нулим сразу.
        const screenVideoTrack = screenTrackRef.current;
        const screenAudioLocal = screenAudioTrackRef.current;
        const mixer = micScreenMixerRef.current;
        screenTrackRef.current = null;
        screenAudioTrackRef.current = null;
        micScreenMixerRef.current = null;

        try {
          screenVideoTrack.stop();
        } catch {
          /* */
        }
        if (screenAudioLocal) {
          // Сначала возвращаем чистый мик на audio-sender, ПОТОМ останавливаем
          // микшер. Иначе пир на 1-2 кадра услышит «никого» (sender держит
          // остановленный mixer.outputTrack).
          if (audioSenderRef.current && micTrackRef.current) {
            try {
              await audioSenderRef.current.replaceTrack(micTrackRef.current);
            } catch {
              /* */
            }
          }
          try {
            screenAudioLocal.stop();
          } catch {
            /* */
          }
          if (mixer) {
            try {
              mixer.destroy();
            } catch {
              /* */
            }
          }
        }
        const s = localStreamRef.current;
        if (s) {
          try {
            s.removeTrack(screenVideoTrack);
          } catch {
            /* */
          }
        }
        setSharingScreen(false);
        if (cameraOn && cameraTrackRef.current) {
          await videoSenderRef.current.replaceTrack(cameraTrackRef.current);
        } else {
          await turnOffVideoSender();
        }
        setLocal(new MediaStream(s ? s.getTracks() : []));
        setTimeout(emitMyMedia, 0);
        return;
      }

      try {
        const display = await captureDisplay(presetKey, includeAudio);
        const track = display.getVideoTracks()[0];
        if (!track) return;
        // captureDisplay в браузере при шеринге окна срезает audio
        // (chromium на Windows не умеет per-window audio — отдаёт системный
        // микшер; см. media.ts). Юзеру говорим, что для звука одного
        // приложения нужен desktop-клиент.
        if ((display as any).windowAudioStripped) {
          toast?.info?.(
            'В браузере звук одного окна захватить нельзя. Откройте OwnCord для десктопа или поделитесь экраном целиком, чтобы передавать звук.',
          );
        }
        // Раньше тут был авто-setDeafened(true) при includeAudio — мол,
        // «избежать эха». Это было ошибкой: deafened глушит ВХОДЯЩЕЕ
        // аудио (см. <RemoteAudio> и mute=deafened), т.е. ты переставал
        // слышать пира при старте демонстрации экрана со звуком. Эхо
        // между screen-audio и нашим mic'ом и так не возникает, т.к.
        // screen capture идёт ОТ системного аудио-выхода, а getUserMedia
        // mic’у включает echoCancellation. Никаких deafen'ов автоматом.
        screenTrackRef.current = track;

        // Добавляем аудио трек из стрима экрана в локальный стрим и на audio sender
        const audioTrack = display.getAudioTracks()[0];
        const s = localStreamRef.current || new MediaStream();
        // Убрать предыдущий видео (камера) из preview, чтобы было видно шаринг
        if (cameraTrackRef.current && s.getTracks().includes(cameraTrackRef.current)) {
          s.removeTrack(cameraTrackRef.current);
        }
        s.addTrack(track);
        if (audioTrack) {
          screenAudioTrackRef.current = audioTrack;
          // Микшируем мик + screen-audio в один трек и ставим его на
          // audio-sender. До этого фикса replaceTrack(audioSender, screenAudio)
          // выкидывал голос с провода (см. createMicScreenMixer в
          // audioProcessing.ts) — пир видел индикатор речи у себя
          // (анализатор крутится на raw-mic), но не слышал ни слова.
          if (audioSenderRef.current && micTrackRef.current) {
            try {
              // На всякий случай: если предыдущий микшер не успел убраться
              // (быстрое off→on), снесём его перед созданием нового.
              if (micScreenMixerRef.current) {
                try {
                  micScreenMixerRef.current.destroy();
                } catch {
                  /* */
                }
                micScreenMixerRef.current = null;
              }
              const mixer = createMicScreenMixer({
                micTrack: micTrackRef.current,
                screenAudioTrack: audioTrack,
              });
              micScreenMixerRef.current = mixer;
              await audioSenderRef.current.replaceTrack(mixer.outputTrack);
            } catch (e) {
              console.error('Failed to attach mic+screen audio mixer:', e);
              // Fallback: если что-то поломалось при сборке миксера, отдаём
              // голый мик (пир не услышит звук стрима, но зато услышит нас).
              try {
                await audioSenderRef.current.replaceTrack(micTrackRef.current);
              } catch {
                /* */
              }
            }
          }
        }
        setLocal(new MediaStream(s.getTracks()));

        await videoSenderRef.current.replaceTrack(track);
        // Поднять maxBitrate под выбранный пресет.
        await applyVideoSenderQuality(videoSenderRef.current, presetKey);
        // Renegotiate, чтобы пир получил свежий SDP с правильными
        // codec/resolution параметрами и сразу — keyframe.
        await renegotiate();
        setSharingScreen(true);
        setTimeout(emitMyMedia, 0);

        // Системная остановка демонстрации (кнопка в OS overlay): зеркалим
        // toggle-off, иначе остаются висеть screen-audio на audio sender'е
        // (мик не возвращается → пира никто не слышит) и dead-track-и в
        // localStreamRef.
        screenTrackRef.current.onended = () => {
          if (screenTrackRef.current !== track) return; // защита от гонок
          if (screenAudioTrackRef.current) {
            // Сначала возвращаем чистый мик на провод, потом сносим миксер
            // и останавливаем screen-audio (порядок важен по той же причине,
            // что и в ручном toggle-off — иначе короткая «тишина» у пира).
            if (audioSenderRef.current && micTrackRef.current) {
              audioSenderRef.current.replaceTrack(micTrackRef.current).catch(() => {
                /* */
              });
            }
            if (micScreenMixerRef.current) {
              try {
                micScreenMixerRef.current.destroy();
              } catch {
                /* */
              }
              micScreenMixerRef.current = null;
            }
            try {
              screenAudioTrackRef.current.stop();
            } catch {
              /* */
            }
            screenAudioTrackRef.current = null;
          }
          const ls = localStreamRef.current;
          if (ls) {
            try {
              ls.removeTrack(track);
            } catch {
              /* */
            }
          }
          screenTrackRef.current = null;
          setSharingScreen(false);
          if (cameraOn && cameraTrackRef.current) {
            videoSenderRef.current.replaceTrack(cameraTrackRef.current).catch(() => {
              /* */
            });
          } else {
            turnOffVideoSender();
          }
          setLocal(new MediaStream(ls ? ls.getTracks() : []));
          setTimeout(emitMyMedia, 0);
        };
      } catch (e) {
        if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') {
          toast?.error?.(prettyMediaError('Не удалось начать демонстрацию', e));
        }
      }
    },
    [cameraOn, emitMyMedia, renegotiate, setLocal, sharingScreen, toast, turnOffVideoSender],
  );

  // --- Обработка сигналинга ---------------------------------------------
  useEffect(() => {
    if (!socket) return undefined;

    const onInvite = ({
      from,
      fromUsername,
      fromDisplayName,
      fromAvatarPath,
      callId,
      withVideo: wv,
    }) => {
      const curState = stateRef.current;

      // Автоматический реджойн: мы в waiting, тот же пир возвращается.
      if (curState === 'waiting' && peerRef.current?.id === from) {
        callIdRef.current = callId;
        setWithVideo(!!wv);
        setWaitingUntil(null);
        setSelfLeft(false);
        setState('connecting');
        // Как callee: создаём свежий PC, шлём accept и ждём offer.
        (async () => {
          try {
            // Треки уже сохранены в refs (не удалялись в waiting),
            // createPeerConnection прикрепит их через addTrack.
            const pc = createPeerConnection('callee');
            socket.emit('call:accept', { to: from, callId });
            void pc;
          } catch (e) {
            toast?.error?.(prettyMediaError('Не удалось переподключиться', e));
            cleanup('rejoin-failed');
          }
        })();
        return;
      }

      if (pcRef.current || curState !== 'idle') {
        socket.emit('call:reject', { to: from, callId, reason: 'busy' });
        return;
      }
      callIdRef.current = callId;
      const p = {
        id: from,
        username: fromUsername,
        displayName: fromDisplayName || fromUsername,
        avatarPath: fromAvatarPath || null,
      };
      peerRef.current = p;
      setPeer(p);
      setWithVideo(!!wv);
      setState('incoming');
      sounds?.startIncoming?.();
    };

    const onOffer = async ({ from, callId, sdp }) => {
      if (!peerRef.current || peerRef.current.id !== from || callIdRef.current !== callId) return;
      if (!pcRef.current) {
        // accept ещё не нажат — сохраним до accept().
        pendingOfferRef.current = sdp;
        return;
      }
      // accept уже создал PC и прицепил треки в createPeerConnection.
      // Просто завершаем negotiation: setRemoteDescription → answer.
      try {
        await pcRef.current.setRemoteDescription(sdp);
        // Safety-net: если по какой-то причине трек не привязан,
        // попробуем привязать сейчас (refs уже точно заполнены).
        if (audioSenderRef.current && !audioSenderRef.current.track && micTrackRef.current) {
          try {
            await audioSenderRef.current.replaceTrack(micTrackRef.current);
          } catch {
            /* */
          }
        }
        if (videoSenderRef.current && !videoSenderRef.current.track) {
          const v = screenTrackRef.current || cameraTrackRef.current || null;
          if (v) {
            try {
              await videoSenderRef.current.replaceTrack(v);
            } catch {
              /* */
            }
          }
        }
        for (const c of iceQueueRef.current) {
          try {
            await pcRef.current.addIceCandidate(c);
          } catch {
            /* */
          }
        }
        iceQueueRef.current = [];
        const answer = await pcRef.current.createAnswer();
        await pcRef.current.setLocalDescription(answer);
        socket.emit('rtc:answer', { to: from, callId, sdp: pcRef.current.localDescription });
      } catch (e) {
        toast?.error?.('Ошибка согласования соединения');
        hangup('offer-failed');
      }
    };

    const onAnswer = async ({ from, callId, sdp }) => {
      if (!peerRef.current || peerRef.current.id !== from || callIdRef.current !== callId) return;
      if (!pcRef.current) return;
      try {
        await pcRef.current.setRemoteDescription(sdp);
        setState((s) => (s === 'calling' ? 'connecting' : s));
        for (const c of iceQueueRef.current) {
          try {
            await pcRef.current.addIceCandidate(c);
          } catch {
            /* */
          }
        }
        iceQueueRef.current = [];
      } catch (e) {
        toast?.error?.('Ошибка согласования соединения');
        hangup('answer-failed');
      }
    };

    const onIce = async ({ from, callId, candidate }) => {
      if (!peerRef.current || peerRef.current.id !== from || callIdRef.current !== callId) return;
      if (!pcRef.current || !pcRef.current.remoteDescription) {
        iceQueueRef.current.push(candidate);
        return;
      }
      try {
        await pcRef.current.addIceCandidate(candidate);
      } catch {
        /* */
      }
    };

    const onAccept = () => {
      sounds?.stopOutgoing?.();
      setState((s) => (s === 'calling' ? 'connecting' : s));
    };

    const onReject = ({ reason }) => {
      sounds?.stopOutgoing?.();
      const msg = reason === 'busy' ? 'Пользователь занят' : 'Звонок отклонён';
      toast?.info?.(msg);
      cleanup(undefined);
    };

    const onCancel = () => {
      sounds?.stopIncoming?.();
      cleanup(undefined);
    };

    const onEnd = ({ reason }) => {
      const curState = stateRef.current;
      // "Временные" причины — пир ушёл, но может вернуться в окне 5 мин.
      const temporary = reason === 'peer-disconnected' || reason === 'peer-leaving';
      const wasTalking = curState === 'in-call' || curState === 'connecting';
      if (temporary && wasTalking) {
        toast?.info?.('Собеседник отключился — ждём возврата');
        enterWaiting(false); // ушёл ПИР → красная End у нас
        return;
      }
      // Защита от дубликата: при F5 у пира сервер мог прислать сначала
      // peer-leaving (от beforeunload), а потом peer-disconnected (от
      // disconnect handler'а). Первый перевёл нас в waiting; второй с
      // прежней логикой провалился бы в cleanup ниже и кикал из звонка.
      // Если мы уже в waiting и причина временная — это эхо, игнор.
      if (temporary && curState === 'waiting') {
        return;
      }
      if (reason === 'peer-disconnected') {
        toast?.info?.('Собеседник отключился');
      }
      cleanup('remote-end');
    };

    const onMediaState = ({ from, callId, state: st }) => {
      if (!peerRef.current || peerRef.current.id !== from || callIdRef.current !== callId) return;
      setPeerMedia({
        mic: !!st?.mic,
        camera: !!st?.camera,
        screen: !!st?.screen,
        screenAudio: !!st?.screenAudio,
        deafened: !!st?.deafened,
      });
    };

    socket.on('call:invite', onInvite);
    socket.on('call:accept', onAccept);
    socket.on('call:reject', onReject);
    socket.on('call:cancel', onCancel);
    socket.on('call:end', onEnd);
    socket.on('rtc:offer', onOffer);
    socket.on('rtc:answer', onAnswer);
    socket.on('rtc:ice', onIce);
    socket.on('media:state', onMediaState);

    return () => {
      socket.off('call:invite', onInvite);
      socket.off('call:accept', onAccept);
      socket.off('call:reject', onReject);
      socket.off('call:cancel', onCancel);
      socket.off('call:end', onEnd);
      socket.off('rtc:offer', onOffer);
      socket.off('rtc:answer', onAnswer);
      socket.off('rtc:ice', onIce);
      socket.off('media:state', onMediaState);
    };
  }, [cleanup, createPeerConnection, enterWaiting, hangup, socket, sounds, toast]);

  // Авто-выход из waiting по истечении окна реконнекта.
  useEffect(() => {
    if (state !== 'waiting' || !waitingUntil) return undefined;
    const ms = Math.max(0, waitingUntil - Date.now());
    const t = setTimeout(() => {
      // Если всё ещё waiting и пир не вернулся — полностью выходим.
      if (stateRef.current === 'waiting') cleanup('waiting-expired');
    }, ms);
    return () => clearTimeout(t);
  }, [state, waitingUntil, cleanup]);

  // --- Voice-activity detection -----------------------------------------
  //
  // Передаём оба стрима (свой + пира) в общий хук-детектор и получаем
  // Set userId-ов, которые сейчас говорят. Используется в `<CallView/>`
  // чтобы подсвечивать активного говорящего (зелёная рамка).
  const speakingStreams = useMemo(() => {
    if (state !== 'in-call') return {};
    const map = {};
    if (localStream) map[selfUser.id] = localStream;
    if (remoteStream && peer?.id) map[peer.id] = remoteStream;
    return map;
  }, [state, localStream, remoteStream, selfUser.id, peer?.id]);

  const speakingUserIds = useSpeakingDetector(speakingStreams, {
    enabled: state === 'in-call',
  });

  // --- beforeunload: корректно уведомляем пира --------------------------
  useEffect(() => {
    const onBeforeUnload = () => {
      if (callIdRef.current && peerRef.current && socket) {
        // emit в том же тике — socket.io отправит, если сможет
        socket.emit('call:end', {
          to: peerRef.current.id,
          callId: callIdRef.current,
          reason: 'peer-leaving',
        });
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [socket]);

  // --- Refresh-resilience: sessionStorage + auto-rejoin -----------------
  // initialSavedCall объявлен в самом начале хука (до useState'ов state/
  // peer/...), чтобы синхронно проинициализировать их в 'waiting'+peer.
  // Здесь — только write-effect для актуализации записи и auto-rejoin.
  //
  // Сохраняем только активные стадии: in-call/connecting/waiting. Стадию
  // 'calling' (исходящий, ещё не принят) не сохраняем — на сервере invite
  // финализируется как cancelled при disconnect каллера, реджойн не
  // имеет шансов. 'incoming' тоже пропускаем — без серверной поддержки
  // восстановить нотификацию нечем.
  //
  // Поскольку state на mount теперь сразу 'waiting' (когда savedCall
  // есть), write-effect синхронизирует данные сразу. callIdRef нужно
  // успеть выставить ДО первого write-effect (state==='waiting' попадёт
  // в первый if). Поэтому подсасываем callId через мутирующий ref-init
  // эффект (см. ниже initialRefsAppliedRef).
  const initialRefsAppliedRef = useRef(false);
  if (!initialRefsAppliedRef.current && initialSavedCall) {
    callIdRef.current = initialSavedCall.callId || null;
    peerRef.current = initialSavedCall.peer || null;
    initialRefsAppliedRef.current = true;
  }

  useEffect(() => {
    try {
      if (state === 'in-call' || state === 'connecting' || state === 'waiting') {
        if (peer && callIdRef.current) {
          sessionStorage.setItem(
            ACTIVE_CALL_STORAGE_KEY,
            JSON.stringify({
              callId: callIdRef.current,
              peer,
              withVideo,
              state,
              selfLeft,
              // На F5 ts не пере-выписываем — он используется для
              // оценки REJOIN_MAX_AGE_MS на следующий маунт; мы хотим
              // сохранить исходное время, иначе пользователь может
              // бесконечно перезагружать страницу и звонок никогда не
              // протухнет (а сервер уже давно его финализировал).
              ts: initialSavedCall?.ts || Date.now(),
            }),
          );
        }
      } else if (state === 'idle') {
        sessionStorage.removeItem(ACTIVE_CALL_STORAGE_KEY);
      }
    } catch {
      /* quota exceeded / disabled storage — игнор */
    }
  }, [state, peer, withVideo, selfLeft, initialSavedCall]);

  // Авто-rejoin после F5 удалён. Он пытался через 800мс дёрнуть
  // start() на восстановленных peer/callId, но при переходе через
  // getLocalMedia нередко ловил error (Chrome бывает забирает mic/cam
  // на короткий период после reload), что фаллилось в hangup
  // с reason='start-failed' → cleanup → idle. Юзер видел
  // «выкидывает». Теперь после F5 юзер остаётся в waiting+selfLeft=true
  // (см. хидрацию selfLeft выше) и видит зелёную Connect — жмёт и
  // переподключается через rejoinAsCaller (тот же server-side
  // rebindForRejoin flow), но уже в ответ на живой user-gesture, так
  // что getUserMedia не падает.

  // --- Audio-pipeline resume при возврате во вкладку --------------------
  // Браузеры (особенно Chromium) могут перевести AudioContext в suspended,
  // когда вкладка уходит в фон или окно теряет фокус. MediaStreamDestination
  // в этом состоянии отдаёт тишину — пир «слышит» только наш голос пока
  // мы СМОТРИМ во вкладку OwnCord. Возврат во вкладку сам по себе ctx
  // не воскрешает: нужно явно вызвать ctx.resume() в активной user-сессии.
  // Слушаем все три события, чтобы покрыть Chrome/Firefox/Safari/мобильные:
  //   - visibilitychange → стандартный сигнал «вкладка снова видна»;
  //   - focus            → дополнительный сигнал на десктопе (alt-tab);
  //   - pageshow         → возврат из bfcache (кнопка «назад»).
  // Пока state=idle — пайплайна нет, эффект no-op'ит.
  useEffect(() => {
    if (state === 'idle') return undefined;
    const tryResume = () => {
      const pipeline = micPipelineRef.current;
      const ctx = pipeline?.context;
      if (!ctx) return;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {
          /* без user activation — попробуем позже */
        });
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') tryResume();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', tryResume);
    window.addEventListener('pageshow', tryResume);
    // Первый прогон — на случай если эффект запустился уже после возврата.
    tryResume();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', tryResume);
      window.removeEventListener('pageshow', tryResume);
    };
  }, [state]);

  return {
    state,
    peer,
    withVideo,
    localStream,
    remoteStream,
    muted,
    deafened,
    cameraOn,
    sharingScreen,
    peerMedia,
    waitingUntil,
    selfLeft,
    speakingUserIds,
    selfId: selfUser.id,
    start,
    accept,
    reject,
    hangup,
    rejoinAsCaller,
    toggleMute,
    toggleDeafen,
    toggleCamera,
    toggleScreenShare,
  };
}

function prettyMediaError(prefix, e) {
  const name = e?.name || '';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError')
    return `${prefix}: устройство не найдено`;
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError')
    return `${prefix}: доступ запрещён`;
  if (name === 'NotReadableError') return `${prefix}: устройство занято другим приложением`;
  if (name === 'OverconstrainedError') return `${prefix}: устройство не поддерживает параметры`;
  return `${prefix}: ${e?.message || e || 'неизвестная ошибка'}`;
}
