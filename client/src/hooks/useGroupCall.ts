import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import {
  captureDisplay,
  captureLocalMedia,
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
import { useSpeakingDetector } from './useSpeakingDetector';

/**
 * useGroupCall — активный групповой звонок (mesh WebRTC).
 *
 * Поддерживает несколько одновременных RTCPeerConnection — по одному на
 * каждого другого участника. Локальный стрим (audio/video) создаётся один раз
 * и прикрепляется ко всем соединениям.
 *
 * Состояния: 'idle' | 'joining' | 'in-call'
 *
 * Публичное API:
 *   state, group, callId,
 *   localStream, remotes: { userId -> MediaStream },
 *   muted, cameraOn,
 *   participants: number[],  — актуальный список (включая self)
 *   join(group, { withVideo })
 *   leave()
 *   toggleMute()
 *   toggleCamera()
 *
 * Сигналинг:
 *   socket.emit('groupcall:join', { groupId, withVideo }, ack)
 *   socket.emit('groupcall:leave', { groupId })
 *   socket.emit('rtc:offer'|'rtc:answer'|'rtc:ice', { to, callId, groupId, … })
 *   socket.on('groupcall:peer-joined', { groupId, callId, userId })
 *   socket.on('groupcall:peer-left',   { groupId, callId, userId })
 *   socket.on('groupcall:ended',       { groupId, callId })
 *   socket.on('rtc:offer'|'rtc:answer'|'rtc:ice', { from, callId, groupId, … })
 */

// SessionStorage-ключ для воскрешения активного группового звонка после
// reload'а. Серверный grace-window для group-call'а — те же 5 минут.
const ACTIVE_GROUPCALL_STORAGE_KEY = 'owncord.activeGroupCall';
const REJOIN_MAX_AGE_MS = 5 * 60 * 1000;

export function useGroupCall({ socket, selfUser, settings, toast, sounds }) {
  const [state, setState] = useState('idle'); // 'idle' | 'joining' | 'in-call'
  const [group, setGroup] = useState(null);
  const [callId, setCallId] = useState(null);
  const [localStream, setLocalStream] = useState(null);
  const [remotes, setRemotes] = useState({}); // userId -> MediaStream
  const [participants, setParticipants] = useState([]);
  // userId -> { mic, camera, screen, screenAudio } — что пиры сейчас шлют.
  // Нужно UI'у, чтобы знать, у кого включён звук стрима: deafen глушит
  // голоса остальных участников, но не должен глушить screen-audio.
  const [peersMedia, setPeersMedia] = useState({});
  const [muted, setMuted] = useState(false);
  // Локальный «глухой режим» — только для UI: все <audio> получают
  // muted=true, микрофон при этом продолжает идти в сеть. Пирам сообщаем
  // через groupcall:media:state, чтобы их UI рисовал иконку «наушники
  // выключены» у нашей плитки. deafenedRef — без closure-stale в emitMyMedia
  // (он мемоизирован на [socket]).
  const [deafened, setDeafened] = useState(false);
  const deafenedRef = useRef(false);
  const [cameraOn, setCameraOn] = useState(false);
  const [sharingScreen, setSharingScreen] = useState(false);
  const [withVideo, setWithVideo] = useState(false);

  const pcsRef = useRef(new Map()); // userId -> RTCPeerConnection
  const iceQueueRef = useRef(new Map()); // userId -> RTCIceCandidate[]
  const localStreamRef = useRef(null);
  const audioTrackRef = useRef(null);
  // Pipeline обработки исходящего микрофона (см. utils/audioProcessing).
  // audioTrackRef.current = pipeline.outputTrack — именно его кладём на
  // sender'ы. Pipeline проживает столько же, сколько активный звонок.
  const micPipelineRef = useRef(null);
  const videoTrackRef = useRef(null); // камера
  const screenTrackRef = useRef(null);
  const screenAudioTrackRef = useRef(null); // Аудио трек из стрима экрана  // демонстрация экрана (приоритет над камерой)
  // Микшер mic + screen-audio. Аналог из useCall.ts: чтобы голос не
  // выкидывался с провода при включении демонстрации со звуком.
  // Жив, пока активна демка с аудио; в applyLocalTracksToPc/createPeer
  // его outputTrack ставится на audio-sender каждого PC вместо голого мика.
  const micScreenMixerRef = useRef<MicScreenMixer | null>(null);
  // Placeholder-треки на случай отсутствия камеры — используются при
  // создании каждого PC, чтобы SDP сразу содержал msid+ssrc и пир
  // получал ontrack ещё до того, как мы реально включим камеру/демку.
  const placeholderAudioRef = useRef(null);
  const placeholderVideoRef = useRef(null);
  const callIdRef = useRef(null);
  const groupRef = useRef(null);
  const stateRef = useRef(state);
  const participantsRef = useRef([]);
  const iceServersRef = useRef(null);
  // Watchdog ICE на каждого пира — иначе мобильные/Yandex могут залипать в
  // checking-state без 'failed'. peerId -> timeout id.
  const iceTimeoutsRef = useRef(new Map());
  // peerId -> stop функция rtc-diag, чтобы в closePeer/cleanup корректно
  // снять diag-цикл. Без этого setInterval жил бы до закрытия окна.
  const rtcDiagStopsRef = useRef<Map<number, () => void>>(new Map());
  const ICE_CONNECT_TIMEOUT_MS = 45_000;

  // Какой трек сейчас должен идти на video-сендер (экран приоритетнее камеры).
  const currentVideoTrack = () => screenTrackRef.current || videoTrackRef.current;

  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  // Загрузка ICE-серверов.
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

  // --- helpers -----------------------------------------------------------
  const addParticipant = useCallback((userId) => {
    setParticipants((prev) => (prev.includes(userId) ? prev : [...prev, userId]));
  }, []);

  const removeParticipant = useCallback((userId) => {
    setParticipants((prev) => prev.filter((id) => id !== userId));
  }, []);

  const setRemoteForPeer = useCallback((userId, stream) => {
    setRemotes((prev) => ({ ...prev, [userId]: stream }));
  }, []);

  const clearRemoteForPeer = useCallback((userId) => {
    setRemotes((prev) => {
      const next = { ...prev };
      delete next[userId];
      return next;
    });
    setPeersMedia((prev) => {
      if (!(userId in prev)) return prev;
      const next = { ...prev };
      delete next[userId];
      return next;
    });
  }, []);

  // Текущее состояние моих медиа для рассылки пирам. Берём enabled-флаг
  // прямо с трека — это источник истины (toggleMute/toggleCamera пишут
  // именно в track.enabled). deafened берём из ref — useState внутри
  // мемоизированного на [socket] callback'а был бы stale.
  const emitMyMedia = useCallback(() => {
    const gid = groupRef.current?.id;
    const cid = callIdRef.current;
    if (!socket || !gid || !cid) return;
    socket.emit('groupcall:media:state', {
      groupId: gid,
      callId: cid,
      state: {
        mic: !!audioTrackRef.current && !!audioTrackRef.current.enabled,
        camera: !!videoTrackRef.current && !!videoTrackRef.current.enabled,
        screen: !!screenTrackRef.current,
        screenAudio: !!screenAudioTrackRef.current,
        deafened: deafenedRef.current,
      },
    });
  }, [socket]);

  const closePeer = useCallback(
    (userId) => {
      const pc = pcsRef.current.get(userId);
      if (pc) {
        try {
          pc.ontrack = null;
          pc.onicecandidate = null;
          pc.onconnectionstatechange = null;
          pc.oniceconnectionstatechange = null;
          pc.close();
        } catch {
          /* ignore */
        }
        pcsRef.current.delete(userId);
      }
      iceQueueRef.current.delete(userId);
      const tid = iceTimeoutsRef.current.get(userId);
      if (tid) {
        clearTimeout(tid);
        iceTimeoutsRef.current.delete(userId);
      }
      const stopDiag = rtcDiagStopsRef.current.get(userId);
      if (stopDiag) {
        try {
          stopDiag();
        } catch {
          /* */
        }
        rtcDiagStopsRef.current.delete(userId);
      }
      clearRemoteForPeer(userId);
    },
    [clearRemoteForPeer],
  );

  const cleanup = useCallback(() => {
    // закрыть все pcs
    for (const [userId] of pcsRef.current) closePeer(userId);
    pcsRef.current.clear();
    iceQueueRef.current.clear();

    // Снимаем все ICE-watchdog'и — иначе они стрельнут в hangup'ах после
    // того, как мы уже закрыли соединения.
    for (const tid of iceTimeoutsRef.current.values()) {
      clearTimeout(tid);
    }
    iceTimeoutsRef.current.clear();
    // closePeer выше уже снял каждый diag, но если по какой-то причине
    // в карте остались висящие stop'ы — гарантированно ронять их.
    for (const stop of rtcDiagStopsRef.current.values()) {
      try {
        stop();
      } catch {
        /* */
      }
    }
    rtcDiagStopsRef.current.clear();

    // остановить треки. Pipeline сам остановит свои raw-треки и закроет
    // AudioContext в destroy() — поэтому делаем destroy ДО обнуления refs.
    if (micPipelineRef.current) {
      try {
        micPipelineRef.current.destroy();
      } catch {
        /* */
      }
      micPipelineRef.current = null;
    }
    // Микшер mic+screen-audio (если демка со звуком была активна на
    // момент leave): закрываем свой AudioContext и outputTrack.
    if (micScreenMixerRef.current) {
      try {
        micScreenMixerRef.current.destroy();
      } catch {
        /* */
      }
      micScreenMixerRef.current = null;
    }
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
    audioTrackRef.current = null;
    videoTrackRef.current = null;
    if (screenTrackRef.current) {
      try {
        screenTrackRef.current.stop();
      } catch {
        /* */
      }
    }
    screenTrackRef.current = null;
    if (placeholderAudioRef.current) {
      try {
        placeholderAudioRef.current.stop();
      } catch {
        /* */
      }
      placeholderAudioRef.current = null;
    }
    if (placeholderVideoRef.current) {
      try {
        placeholderVideoRef.current.stop();
      } catch {
        /* */
      }
      placeholderVideoRef.current = null;
    }
    setSharingScreen(false);

    callIdRef.current = null;
    groupRef.current = null;

    setLocalStream(null);
    setRemotes({});
    setParticipants([]);
    setPeersMedia({});
    setMuted(false);
    setDeafened(false);
    deafenedRef.current = false;
    setCameraOn(false);
    setWithVideo(false);
    setGroup(null);
    setCallId(null);
    setState('idle');
  }, [closePeer]);

  // Заменить локальные треки на sender'ах pc (без renegotiation).
  // Используется при toggleScreenShare/toggleCamera. Если реального трека
  // нет, оставляем на sender placeholder, чтобы транспортный канал не
  // ломался (msid/ssrc остаются прежние и пир продолжает receive ontrack).
  const applyLocalTracksToPc = useCallback((pc) => {
    const aS = pc.__audioSender;
    const vS = pc.__videoSender;
    // Если идёт screen-share со звуком — берём microphone+screen микшер
    // (mixer.outputTrack), чтобы пиры слышали И голос, И звук стрима
    // одновременно. Без микшера replaceTrack(audioSender, screenAudio)
    // выкидывал бы голос с провода — это и был баг "стрим со звуком ⇒
    // меня не слышно". См. createMicScreenMixer в audioProcessing.ts.
    const mixedAudio = micScreenMixerRef.current?.outputTrack || null;
    let aTrack = mixedAudio || audioTrackRef.current;
    if (!aTrack) {
      if (!placeholderAudioRef.current) {
        placeholderAudioRef.current = createPlaceholderAudioTrack();
      }
      aTrack = placeholderAudioRef.current;
    }
    let vTrack = currentVideoTrack();
    if (!vTrack) {
      if (!placeholderVideoRef.current) {
        placeholderVideoRef.current = createPlaceholderVideoTrack();
      }
      vTrack = placeholderVideoRef.current;
    }
    if (aS && aS.track !== aTrack) {
      try {
        aS.replaceTrack(aTrack);
      } catch {
        /* */
      }
    }
    if (vS && vS.track !== vTrack) {
      try {
        vS.replaceTrack(vTrack);
      } catch {
        /* */
      }
    }
  }, []);

  // ВАЖНО: createPeerConnection нужно вызывать ПОСЛЕ getUserMedia —
  // на момент создания pc нам нужны audioTrackRef.current/videoTrackRef.current,
  // чтобы прикрепить их через addTrack. Если их нет — медиа не польётся.
  const createPeerConnection = useCallback(
    (peerId, isInitiator) => {
      const pc = new RTCPeerConnection(
        buildRtcConfig(iceServersRef.current, {
          forceTurnRelay: !!settings?.forceTurnRelay,
        }),
      );
      pcsRef.current.set(peerId, pc);
      // На каждый peer-pc — отдельный diag-цикл. Снимается в closePeer/cleanup.
      const prevStop = rtcDiagStopsRef.current.get(peerId);
      if (prevStop) {
        try {
          prevStop();
        } catch {
          /* */
        }
      }
      rtcDiagStopsRef.current.set(peerId, startRtcDiag(pc, `group#${peerId}`));

      // ВСЕГДА addTrack с реальным MediaStreamTrack (или placeholder).
      // Без этого Chrome не fire-ит ontrack у пира при последующем
      // replaceTrack — демонстрация экрана/камера от не-инициатора
      // оказывались невидимыми у других участников.
      // Аудио: при активном screen-share с аудио — mixer.outputTrack (mic +
      // системный звук), иначе чистый мик. Late joiner сразу получит то же,
      // что и остальные участники, без дополнительного renegotiation.
      const ls = localStreamRef.current;
      const aTrack = micScreenMixerRef.current?.outputTrack || audioTrackRef.current;
      const vTrack = currentVideoTrack();

      let audioForSender = aTrack;
      if (!audioForSender) {
        if (!placeholderAudioRef.current) {
          placeholderAudioRef.current = createPlaceholderAudioTrack();
        }
        audioForSender = placeholderAudioRef.current;
      }
      const audioSender = pc.addTrack(audioForSender, ls || new MediaStream([audioForSender]));

      let videoForSender = vTrack;
      if (!videoForSender) {
        if (!placeholderVideoRef.current) {
          placeholderVideoRef.current = createPlaceholderVideoTrack();
        }
        videoForSender = placeholderVideoRef.current;
      }
      const videoSender = pc.addTrack(videoForSender, ls || new MediaStream([videoForSender]));

      pc.__audioSender = audioSender;
      pc.__videoSender = videoSender;

      pc.ontrack = (ev) => {
        // Собираем все актуальные треки пира в один stream
        setRemotes((prev) => {
          const prevStream = prev[peerId];
          const set = new Set<MediaStreamTrack>(prevStream ? prevStream.getTracks() : []);
          const before = set.size;
          if (ev.streams[0]) {
            for (const t of ev.streams[0].getTracks()) set.add(t);
          } else {
            set.add(ev.track);
          }
          // Если набор треков не изменился — оставляем прежний MediaStream,
          // чтобы не триггерить пересборку srcObject/play() в RemoteAudio.
          if (prevStream && set.size === before) return prev;
          return { ...prev, [peerId]: new MediaStream([...set]) };
        });
      };

      pc.onicecandidate = (ev) => {
        if (!ev.candidate) return;
        if (!groupRef.current || !callIdRef.current) return;
        socket.emit('rtc:ice', {
          to: peerId,
          callId: callIdRef.current,
          groupId: groupRef.current.id,
          candidate: ev.candidate,
        });
      };

      pc.onconnectionstatechange = () => {
        const s = pc.connectionState;
        if (s === 'connected') {
          // Соединение установлено — снимаем watchdog по этому пиру.
          const tid = iceTimeoutsRef.current.get(peerId);
          if (tid) {
            clearTimeout(tid);
            iceTimeoutsRef.current.delete(peerId);
          }
          // Свежеподключённому пиру нужно отдать наше актуальное media-state,
          // иначе у него ползунок громкости стрима не будет понимать, что
          // у нас идёт screen-audio (а не голос).
          setTimeout(emitMyMedia, 0);
        }
        if (s === 'failed' || s === 'closed') {
          closePeer(peerId);
        }
      };

      // Дублируем как ice-state — старые Chromium-сборки (Yandex, WebView)
      // не апдейтят connectionState, а ice-state даёт сигнал перехода.
      pc.oniceconnectionstatechange = () => {
        const s = pc.iceConnectionState;
        if (s === 'connected' || s === 'completed') {
          const tid = iceTimeoutsRef.current.get(peerId);
          if (tid) {
            clearTimeout(tid);
            iceTimeoutsRef.current.delete(peerId);
          }
        }
        if (s === 'failed') {
          const tid = iceTimeoutsRef.current.get(peerId);
          if (tid) {
            clearTimeout(tid);
            iceTimeoutsRef.current.delete(peerId);
          }
          // В групповом звонке не роняем весь сейшн — закрываем только этого пира.
          // UI увидит peer-left от сервера или просто пустую плитку.
          closePeer(peerId);
        }
      };

      // Watchdog: если ICE этого пира за 45с не пришёл в 'connected'/'completed' —
      // закрываем PC и убираем плитку. Без этого один «зависший» пир (мобильный
      // оператор/Yandex) держит у нас «Соединение…» на его плитке вечно.
      const tid = setTimeout(() => {
        iceTimeoutsRef.current.delete(peerId);
        const cur = pcsRef.current.get(peerId);
        if (cur !== pc) return;
        const cs = pc.connectionState;
        const ics = pc.iceConnectionState;
        if (cs === 'connected' || ics === 'connected' || ics === 'completed') return;
        console.warn(`groupcall: peer ${peerId} ICE timeout, closing`);
        closePeer(peerId);
      }, ICE_CONNECT_TIMEOUT_MS);
      iceTimeoutsRef.current.set(peerId, tid);

      // Стартовый offer инициирует тот, чей id меньше (детерминированно).
      if (isInitiator) {
        (async () => {
          try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            if (!groupRef.current || !callIdRef.current) return;
            socket.emit('rtc:offer', {
              to: peerId,
              callId: callIdRef.current,
              groupId: groupRef.current.id,
              sdp: pc.localDescription,
            });
          } catch (e) {
            console.warn('groupcall offer error', e);
          }
        })();
      }

      return pc;
    },
    [closePeer, emitMyMedia, socket, settings?.forceTurnRelay],
  );

  // --- public API --------------------------------------------------------
  const join = useCallback(
    async (targetGroup, { withVideo: wantVideo = false } = {}) => {
      if (stateRef.current !== 'idle') return;
      setState('joining');
      setGroup(targetGroup);
      groupRef.current = targetGroup;
      setWithVideo(!!wantVideo);

      try {
        const audioConstraint = {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(settings?.inputDeviceId && settings.inputDeviceId !== 'default'
            ? { deviceId: { exact: settings.inputDeviceId } }
            : {}),
        };
        let rawStream;
        try {
          rawStream = await navigator.mediaDevices.getUserMedia({
            audio: audioConstraint,
            video: wantVideo ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
          });
        } catch (err) {
          // Если deviceId стал невалидным (микрофон сменили/отключили) —
          // пробуем без exact-deviceId, иначе вызов ляжет в OverconstrainedError.
          if (err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError') {
            rawStream = await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              },
              video: wantVideo ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
            });
          } else {
            throw err;
          }
        }

        const rawMic = rawStream.getAudioTracks()[0] || null;
        videoTrackRef.current = rawStream.getVideoTracks()[0] || null;

        // Прогоняем микрофон через AudioContext-pipeline (HighPass →
        // Compressor → NoiseGate → MakeupGain). На sender'ы попадает
        // processed-трек; raw-mic живёт внутри pipeline и завершится в
        // pipeline.destroy().
        //
        // audioFiltersEnabled === false — глобальный bypass pipeline'а
        // для Electron-десктопа (см. useCall.ts/SettingsContext: там же
        // описание бага с suspended AudioContext).
        let processedMic = rawMic;
        // См. подробный комментарий в useCall.ts (там же логика). Кратко:
        // в Electron-десктопе RTCRtpSender энкодит трек от
        // MediaStreamDestination в тишину, даже если AudioContext running.
        // Поэтому в RTC всегда уходит сырой mic из getUserMedia. Web
        // остаётся без изменений.
        const wantPipeline = rawMic && settings?.audioFiltersEnabled !== false && !isDesktop();
        if (wantPipeline) {
          try {
            const pipeline = await createMicPipeline(
              new MediaStream([rawMic]),
              pickAudioFilterSettings(settings),
            );
            // Watchdog: AudioContext должен быть в running-state, иначе
            // MediaStreamDestination отдаёт «немой» трек. Даём 150 мс
            // на стабилизацию resume(), потом проверяем.
            await new Promise((resolve) => setTimeout(resolve, 150));
            if (pipeline.context.state !== 'running') {
              console.warn(
                '[useGroupCall] mic pipeline AudioContext не запустился (state=',
                pipeline.context.state,
                ') — fallback на сырой mic-трек',
              );
              try {
                pipeline.destroy();
              } catch {
                /* */
              }
              processedMic = rawMic;
            } else {
              micPipelineRef.current = pipeline;
              processedMic = pipeline.outputTrack;
            }
          } catch (e) {
            console.warn('Mic pipeline failed, falling back to raw track:', e);
            processedMic = rawMic;
          }
        }
        audioTrackRef.current = processedMic;

        const ls = new MediaStream();
        if (processedMic) ls.addTrack(processedMic);
        if (videoTrackRef.current) ls.addTrack(videoTrackRef.current);
        localStreamRef.current = ls;
        if (videoTrackRef.current) setCameraOn(true);
        setLocalStream(ls);

        // Отправляем серверу запрос на присоединение
        const ack = await new Promise<any>((resolve) => {
          socket.emit(
            'groupcall:join',
            { groupId: targetGroup.id, withVideo: !!wantVideo },
            resolve,
          );
        });
        if (ack?.error) throw new Error(ack.error);

        callIdRef.current = ack.callId;
        setCallId(ack.callId);
        setState('in-call');
        sounds?.playConnect?.();

        // Добавим себя в список участников
        setParticipants([selfUser.id, ...(ack.peers || [])]);

        // Для каждого уже присутствующего пира: инициируем, если my_id < peer_id
        for (const peerId of ack.peers || []) {
          const iAmInitiator = selfUser.id < peerId;
          createPeerConnection(peerId, iAmInitiator);
        }
      } catch (e) {
        toast?.error?.(`Не удалось присоединиться: ${e.message || e}`);
        cleanup();
      }
    },
    [cleanup, createPeerConnection, selfUser.id, settings, socket, sounds, toast],
  );

  const leave = useCallback(() => {
    if (stateRef.current === 'idle') return;
    const gid = groupRef.current?.id;
    if (socket && gid) socket.emit('groupcall:leave', { groupId: gid });
    sounds?.playDisconnect?.();
    cleanup();
  }, [cleanup, socket, sounds]);

  const toggleMute = useCallback(() => {
    const t = audioTrackRef.current;
    if (!t) return;
    t.enabled = !t.enabled;
    setMuted(!t.enabled);
    // Пип перед emitMyMedia — локальный фидбэк не должен
    // ждать сети. t.enabled уже отражает новое состояние.
    if (t.enabled) sounds?.playMicUnmute?.();
    else sounds?.playMicMute?.();
    setTimeout(emitMyMedia, 0);
  }, [emitMyMedia, sounds]);

  // Прокидываем изменения фильтров в живой mic-pipeline без пересборки.
  // useEffect-сравнение по плоским ключам, чтобы reconciler не дёргался
  // на каждой мутации settings (там есть карты userVolumes/streamVolumes).
  useEffect(() => {
    const pipeline = micPipelineRef.current;
    if (!pipeline) return;
    try {
      pipeline.updateSettings(pickAudioFilterSettings(settings));
    } catch {
      /* ignore */
    }
  }, [
    settings?.inputVolume,
    settings?.noiseSuppression,
    settings?.noiseThreshold,
    settings?.noiseGateHoldMs,
    settings?.noiseGateAttackMs,
    settings?.noiseGateReleaseMs,
    settings?.highPassFilter,
    settings?.highPassFrequency,
    settings?.compressorEnabled,
    settings?.compressorThreshold,
    settings?.compressorRatio,
    settings?.compressorAttack,
    settings?.compressorRelease,
    settings?.compressorKnee,
    settings?.makeupGainDb,
  ]);

  // --- Live mic-swap (group call) -------------------------------------
  // Зеркало useCall.ts — но проходит по всем PC из pcsRef и заменяет
  // трек у каждого пира. Фильтры/устройство применяются «на лету», без
  // переподключения к группе и без обрыва RTP.
  const swappingMicRef = useRef(false);
  useEffect(() => {
    if (stateRef.current !== 'in-call') return undefined;
    if (pcsRef.current.size === 0) return undefined;
    let cancelled = false;

    (async () => {
      if (swappingMicRef.current) return;
      swappingMicRef.current = true;
      try {
        // 1) Свежий raw-stream с новым deviceId. Камеру не трогаем.
        const rawStream = await captureLocalMedia({
          wantVideo: false,
          audioDeviceId: settings?.inputDeviceId,
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

        const wasEnabled = audioTrackRef.current?.enabled ?? true;

        // 2) Pipeline (web only, см. подробный комментарий в join()).
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
              console.warn('[useGroupCall] swap pipeline ctx не запустился — fallback на raw');
              try {
                pipeline.destroy();
              } catch {
                /* */
              }
            }
          } catch (e) {
            console.warn('[useGroupCall] swap: pipeline build failed:', e);
          }
        }
        newProcessedMic.enabled = wasEnabled;

        // 3) Если идёт демка со звуком — пересобираем mic+screen микшер
        //    с новым mic'ом (см. useCall.ts с тем же объяснением).
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
            console.warn('[useGroupCall] swap: mixer rebuild failed:', e);
          }
        }

        // 4) Replace track на КАЖДОМ pc. Если у одного из пиров отвалится —
        //    остальные всё равно получат новый звук.
        const peers = Array.from(pcsRef.current.entries());
        let anyReplaced = false;
        for (const [peerId, pc] of peers) {
          if (cancelled) break;
          const sender = (pc as any).__audioSender;
          if (!sender) continue;
          try {
            await sender.replaceTrack(trackForSender);
            anyReplaced = true;
          } catch (e) {
            console.warn(`[useGroupCall] swap replaceTrack peer=${peerId} failed:`, e);
          }
        }

        if (cancelled || !anyReplaced) {
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

        // 5) Демонтаж старого. Pipeline.destroy() уберёт свой raw + output;
        //    иначе явно стопаем старый mic-track.
        const oldMicTrack = audioTrackRef.current;
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

        // 6) Обновляем refs и localStream.
        audioTrackRef.current = newProcessedMic;
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
            /* track уже там — ок */
          }
          localStreamRef.current = new MediaStream(ls.getTracks());
          setLocalStream(localStreamRef.current);
        }

        setTimeout(emitMyMedia, 0);
      } catch (e) {
        console.warn('[useGroupCall] swapMicrophone failed:', e);
        toast?.error?.('Не удалось применить новые настройки микрофона');
      } finally {
        swappingMicRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.inputDeviceId, settings?.audioFiltersEnabled]);

  const toggleDeafen = useCallback(() => {
    const next = !deafenedRef.current;
    deafenedRef.current = next;
    setDeafened(next);
    // UI-пип проходит через отдельный AudioContext useSounds,
    // а не через <RemoteAudio>, который мы замьютим этим
    // тогглом — так что звук deafen-уведомления будет слышен
    // вне зависимости от направления переключения.
    if (next) sounds?.playDeafen?.();
    else sounds?.playUndeafen?.();
    // Сообщаем пирам — они покажут иконку «наушники выключены»
    // у нашей плитки. WebRTC-трафик никак не меняется — это чистый сигналинг.
    setTimeout(emitMyMedia, 0);
  }, [emitMyMedia, sounds]);

  // Глобальные хоткеи десктопа. Подписка зеркалит useCall.ts —
  // см. там подробный комментарий. Гейтим listener за state, иначе
  // toggleDeafen бы срабатывал и в idle (у него нет трекового гейта).
  useEffect(() => {
    if (state !== 'in-call' && state !== 'joining') return undefined;
    return onShortcutEvent((action) => {
      if (action === 'toggleMute') toggleMute();
      else if (action === 'toggleDeafen') toggleDeafen();
    });
  }, [toggleMute, toggleDeafen, state]);

  const toggleCamera = useCallback(() => {
    const t = videoTrackRef.current;
    if (!t) return;
    t.enabled = !t.enabled;
    setCameraOn(t.enabled);
    setTimeout(emitMyMedia, 0);
  }, [emitMyMedia]);

  // Renegotiate ОДНОГО pc (для одного пира). Используется после
  // replaceTrack(real screen) — без renegotiation у пира остаются
  // codec-параметры от placeholder-канвы (низкое разрешение, низкий
  // битрейт), и картинка идёт мутной/с задержкой keyframe.
  const renegotiatePeer = useCallback(
    async (peerId) => {
      const pc = pcsRef.current.get(peerId);
      if (!pc) return;
      if (pc.signalingState !== 'stable') return; // glare avoidance
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        if (!groupRef.current || !callIdRef.current) return;
        socket.emit('rtc:offer', {
          to: peerId,
          callId: callIdRef.current,
          groupId: groupRef.current.id,
          sdp: pc.localDescription,
        });
      } catch {
        /* */
      }
    },
    [socket],
  );

  // Демонстрация экрана для группового звонка.
  //   1) replaceTrack на video-sender'ах всех pc (placeholder → real screen);
  //   2) applyVideoSenderQuality(maxBitrate) под выбранный пресет;
  //   3) renegotiate каждого pc, чтобы пир получил свежий SDP/keyframe и
  //      сразу увидел реальную картинку (а не остался с placeholder).
  const toggleScreenShare = useCallback(
    async (presetKey = '720p', includeAudio = false) => {
      if (stateRef.current !== 'in-call') return;

      if (sharingScreen && screenTrackRef.current) {
        // Выключаем демку — возвращаем камеру (если была) или placeholder.
        // Захватываем треки и нулим ref'ы ДО stop()/await — чтобы наш же
        // onended-handler, отрабатывающий на ended event от .stop(), увидел
        // screenTrackRef.current === null и вышел по race-guard'у.
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
          // applyLocalTracksToPc ниже уже подберёт чистый мик (mixer.outputTrack
          // → audioTrackRef.current), потому что mixerRef уже обнулён. Нам
          // остаётся только остановить screen-audio и снести сам микшер.
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
        setSharingScreen(false);
        // Ребилд localStream от первичных треков. Раньше делали filter по
        // kind !== 'video', но это сохраняло уже остановленный screen-audio
        // в стриме (он добавлялся в ls при старте и не вычищался при стопе).
        const tracks = [];
        if (audioTrackRef.current) tracks.push(audioTrackRef.current);
        if (videoTrackRef.current) tracks.push(videoTrackRef.current);
        const next = new MediaStream(tracks);
        localStreamRef.current = next;
        setLocalStream(next);
        for (const [peerId, pc] of pcsRef.current) {
          applyLocalTracksToPc(pc);
          renegotiatePeer(peerId);
        }
        setTimeout(emitMyMedia, 0);
        return;
      }

      let display;
      try {
        display = await captureDisplay(presetKey, includeAudio);
        // Авто-deafen при includeAudio убран намеренно (как и в useCall):
        // он глушил ВХОДЯЩЕЕ аудио, т.е. ты переставал слышать остальных
        // участников при старте демки со звуком. echoCancellation у мика
        // и так не даёт фидбэка, потому что screen-audio идёт от системного
        // выхода, а не из мика.
      } catch (e) {
        if (e?.name !== 'NotAllowedError' && e?.name !== 'AbortError') {
          toast?.error?.(`Не удалось начать демонстрацию: ${e.message || e}`);
        }
        return;
      }
      const track = display.getVideoTracks()[0];
      if (!track) return;
      // captureDisplay в браузере при шеринге окна срезает audio (chromium
      // на Windows не умеет per-window audio — отдаёт системный микшер;
      // см. media.ts). Сообщаем юзеру про десктоп-клиент.
      if ((display as any).windowAudioStripped) {
        toast?.info?.(
          'В браузере звук одного окна захватить нельзя. Откройте OwnCord для десктопа или поделитесь экраном целиком, чтобы передавать звук.',
        );
      }
      screenTrackRef.current = track;

      // Добавляем аудио трек из стрима экрана
      const audioTrack = display.getAudioTracks()[0];
      if (audioTrack) {
        screenAudioTrackRef.current = audioTrack;
        // Собираем микшер mic + screen-audio. applyLocalTracksToPc после
        // этого подберёт mixer.outputTrack как audio-track и поставит его
        // на каждый __audioSender. Голос продолжает идти параллельно
        // системному звуку.
        if (audioTrackRef.current) {
          try {
            if (micScreenMixerRef.current) {
              try {
                micScreenMixerRef.current.destroy();
              } catch {
                /* */
              }
              micScreenMixerRef.current = null;
            }
            micScreenMixerRef.current = createMicScreenMixer({
              micTrack: audioTrackRef.current,
              screenAudioTrack: audioTrack,
            });
          } catch (e) {
            console.error('Failed to attach mic+screen audio mixer (group):', e);
          }
        }
        // В localStream добавляем сырой screen-audio (а не mixer.outputTrack)
        // только для UI/отладки — на провод идёт mixer через applyLocalTracksToPc.
        const ls = localStreamRef.current || new MediaStream();
        ls.addTrack(audioTrack);
        localStreamRef.current = ls;
        setLocalStream(ls);
        // Обновляем все pc чтобы отправить аудио трек
        for (const [peerId, pc] of pcsRef.current) {
          applyLocalTracksToPc(pc);
          renegotiatePeer(peerId);
        }
      }
      setSharingScreen(true);

      track.addEventListener('ended', () => {
        if (screenTrackRef.current !== track) return;
        screenTrackRef.current = null;
        // Звуковой трек экрана живёт пока работает демка — при остановке
        // демки через системный «Остановить показ» его тоже надо завершить
        // и убрать из локального стрима, иначе screenAudio-флаг останется true.
        if (screenAudioTrackRef.current) {
          try {
            screenAudioTrackRef.current.stop();
          } catch {
            /* */
          }
          screenAudioTrackRef.current = null;
        }
        // Микшер тоже сносим — applyLocalTracksToPc ниже подберёт чистый мик.
        if (micScreenMixerRef.current) {
          try {
            micScreenMixerRef.current.destroy();
          } catch {
            /* */
          }
          micScreenMixerRef.current = null;
        }
        setSharingScreen(false);
        // Восстанавливаем чистый набор: только мик-аудио + камера (если есть).
        const tracks = [];
        if (audioTrackRef.current) tracks.push(audioTrackRef.current);
        if (videoTrackRef.current) tracks.push(videoTrackRef.current);
        const next = new MediaStream(tracks);
        localStreamRef.current = next;
        setLocalStream(next);
        for (const [peerId, pc] of pcsRef.current) {
          applyLocalTracksToPc(pc);
          renegotiatePeer(peerId);
        }
        setTimeout(emitMyMedia, 0);
      });

      // Локальное превью: заменить камеру на screen.
      const ls = localStreamRef.current || new MediaStream();
      const others = ls.getTracks().filter((t) => t.kind !== 'video');
      const next = new MediaStream([...others, track]);
      localStreamRef.current = next;
      setLocalStream(next);

      for (const [peerId, pc] of pcsRef.current) {
        applyLocalTracksToPc(pc);
        if (pc.__videoSender) {
          await applyVideoSenderQuality(pc.__videoSender, presetKey);
        }
        renegotiatePeer(peerId);
      }
      setTimeout(emitMyMedia, 0);
    },
    [applyLocalTracksToPc, deafened, emitMyMedia, renegotiatePeer, sharingScreen, toast],
  );

  // --- signaling handlers -----------------------------------------------
  useEffect(() => {
    if (!socket) return undefined;

    const isMyCall = (payload) => {
      const gid = groupRef.current?.id;
      const cid = callIdRef.current;
      if (!gid || !cid) return false;
      if (payload.groupId !== gid) return false;
      // callId строгой проверки пока не делаем — сервер может прислать r2 при рестарте
      return true;
    };

    const onPeerJoined = ({ groupId, userId }) => {
      if (!groupRef.current || groupRef.current.id !== groupId) return;
      if (userId === selfUser.id) return;
      addParticipant(userId);
      // Инициируем соединение, если my_id < peer_id
      if (selfUser.id < userId) {
        createPeerConnection(userId, true);
      } else {
        // Дождёмся offer от пира.
      }
    };

    const onPeerLeft = ({ groupId, userId }) => {
      if (!groupRef.current || groupRef.current.id !== groupId) return;
      if (userId === selfUser.id) return;
      closePeer(userId);
      removeParticipant(userId);
    };

    const onEnded = ({ groupId }) => {
      if (!groupRef.current || groupRef.current.id !== groupId) return;
      sounds?.playDisconnect?.();
      cleanup();
    };

    const onOffer = async ({ from, sdp, groupId }) => {
      if (!isMyCall({ groupId })) return;
      if (from === selfUser.id) return;
      let pc = pcsRef.current.get(from);
      if (!pc) pc = createPeerConnection(from, false);
      try {
        await pc.setRemoteDescription(sdp);
        // PC уже создан с sendrecv-transceivers и привязанными локальными
        // треками (см. createPeerConnection). На случай renegotiation
        // (когда pc существовал) — синхронизируем sender'ы с актуальными
        // треками из refs.
        applyLocalTracksToPc(pc);
        // flush ICE queue
        const q = iceQueueRef.current.get(from) || [];
        for (const c of q) {
          try {
            await pc.addIceCandidate(c);
          } catch {
            /* */
          }
        }
        iceQueueRef.current.delete(from);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('rtc:answer', {
          to: from,
          callId: callIdRef.current,
          groupId,
          sdp: pc.localDescription,
        });
        addParticipant(from);
      } catch (e) {
        console.warn('groupcall onOffer error', e);
      }
    };

    const onAnswer = async ({ from, sdp, groupId }) => {
      if (!isMyCall({ groupId })) return;
      if (from === selfUser.id) return;
      const pc = pcsRef.current.get(from);
      if (!pc) return;
      try {
        await pc.setRemoteDescription(sdp);
        const q = iceQueueRef.current.get(from) || [];
        for (const c of q) {
          try {
            await pc.addIceCandidate(c);
          } catch {
            /* */
          }
        }
        iceQueueRef.current.delete(from);
      } catch (e) {
        console.warn('groupcall onAnswer error', e);
      }
    };

    const onIce = async ({ from, candidate, groupId }) => {
      if (!isMyCall({ groupId })) return;
      if (from === selfUser.id) return;
      const pc = pcsRef.current.get(from);
      if (!pc || !pc.remoteDescription) {
        const arr = iceQueueRef.current.get(from) || [];
        arr.push(candidate);
        iceQueueRef.current.set(from, arr);
        return;
      }
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        /* */
      }
    };

    const onMediaState = ({ from, callId, groupId, state: st }) => {
      if (!isMyCall({ groupId })) return;
      if (callIdRef.current !== callId) return;
      if (from === selfUser.id) return;
      setPeersMedia((prev) => ({
        ...prev,
        [from]: {
          mic: !!st?.mic,
          camera: !!st?.camera,
          screen: !!st?.screen,
          screenAudio: !!st?.screenAudio,
          deafened: !!st?.deafened,
        },
      }));
    };

    socket.on('groupcall:peer-joined', onPeerJoined);
    socket.on('groupcall:peer-left', onPeerLeft);
    socket.on('groupcall:ended', onEnded);
    socket.on('groupcall:media:state', onMediaState);
    socket.on('rtc:offer', onOffer);
    socket.on('rtc:answer', onAnswer);
    socket.on('rtc:ice', onIce);

    return () => {
      socket.off('groupcall:peer-joined', onPeerJoined);
      socket.off('groupcall:peer-left', onPeerLeft);
      socket.off('groupcall:ended', onEnded);
      socket.off('groupcall:media:state', onMediaState);
      socket.off('rtc:offer', onOffer);
      socket.off('rtc:answer', onAnswer);
      socket.off('rtc:ice', onIce);
    };
  }, [
    addParticipant,
    applyLocalTracksToPc,
    cleanup,
    closePeer,
    createPeerConnection,
    removeParticipant,
    selfUser.id,
    socket,
    sounds,
  ]);

  // --- Voice-activity detection -----------------------------------------
  //
  // Собираем карту userId → MediaStream для всех участников, у которых
  // есть аудио-трек: свой стрим + удалённые. Хук возвращает Set userId-ов,
  // которые сейчас «говорят». UI рисует зелёную рамку вокруг плитки.
  // Когда state=idle — детектор отключён, чтобы не держать AudioContext.
  const speakingStreams = useMemo(() => {
    if (state === 'idle') return {};
    const map = {};
    if (localStream) map[selfUser.id] = localStream;
    for (const [uid, s] of Object.entries(remotes)) {
      if (s) map[uid] = s;
    }
    return map;
  }, [state, localStream, remotes, selfUser.id]);

  const speakingUserIds = useSpeakingDetector(speakingStreams, {
    enabled: state === 'in-call',
  });

  // Корректно уведомляем сервер при закрытии вкладки и закрываем все PC,
  // чтобы пиры не висели «связанными» 30-60 сек до ICE timeout. Сервер,
  // конечно, тоже отрубит висящего участника по disconnect, но это даёт
  // визуально мгновенный peer-left у остальных.
  useEffect(() => {
    const onBeforeUnload = () => {
      const gid = groupRef.current?.id;
      if (gid && socket) socket.emit('groupcall:leave', { groupId: gid });
      // Локально закрываем все PeerConnection и стопаем медиа — иначе
      // освобождение микрофона/камеры может задержаться, пока браузер
      // не уничтожит вкладку, и индикатор записи в трее остаётся гореть.
      try {
        for (const pc of pcsRef.current.values()) {
          try {
            pc.close();
          } catch {
            /* */
          }
        }
        pcsRef.current.clear();
      } catch {
        /* */
      }
      try {
        const s = localStreamRef.current;
        if (s)
          for (const t of s.getTracks()) {
            try {
              t.stop();
            } catch {
              /* */
            }
          }
      } catch {
        /* */
      }
      try {
        screenTrackRef.current?.stop?.();
      } catch {
        /* */
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [socket]);

  // --- Refresh-resilience: sessionStorage + auto-rejoin -----------------
  // На reload теряются все треки и pcs, и пользователь оказывается в
  // 'idle'. Сервер на disconnect помечает участника, но сама group-call-
  // сессия не финализируется, пока есть хотя бы один живой участник или
  // 5-минутное окно ожидания ещё не вышло. Если запомним groupId+
  // withVideo в sessionStorage, на маунте можем сами вызвать join()
  // заново — сервер примет, остальные получат peer-joined и mesh
  // пересоберётся.
  //
  // Те же гонки, что и в useCall: read через useState-initializer
  // СИНХРОННО, write-effect пропускает первый проход в state==='idle'.
  const [initialSavedGroupCall] = useState(() => {
    try {
      const raw = sessionStorage.getItem(ACTIVE_GROUPCALL_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.group || typeof parsed.group.id !== 'number') return null;
      if (Date.now() - (parsed.ts || 0) > REJOIN_MAX_AGE_MS) return null;
      return parsed;
    } catch {
      return null;
    }
  });

  const persistInitDoneRef = useRef(false);
  useEffect(() => {
    if (!persistInitDoneRef.current) {
      persistInitDoneRef.current = true;
      if (state === 'idle') return;
    }
    try {
      if (state === 'in-call' || state === 'joining') {
        if (group && group.id) {
          sessionStorage.setItem(
            ACTIVE_GROUPCALL_STORAGE_KEY,
            JSON.stringify({
              group,
              withVideo,
              callId,
              ts: Date.now(),
            }),
          );
        }
      } else if (state === 'idle') {
        sessionStorage.removeItem(ACTIVE_GROUPCALL_STORAGE_KEY);
      }
    } catch {
      /* quota / disabled — игнор */
    }
  }, [state, group, withVideo, callId]);

  const autoRejoinedRef = useRef(false);
  const joinRef = useRef<any>(null);
  useEffect(() => {
    joinRef.current = join;
  });

  useEffect(() => {
    if (!socket || !selfUser?.id) return undefined;
    if (autoRejoinedRef.current) return undefined;
    if (!initialSavedGroupCall) return undefined;
    autoRejoinedRef.current = true;
    const timer = setTimeout(() => {
      if (stateRef.current !== 'idle') return;
      const fn = joinRef.current;
      if (typeof fn !== 'function') return;
      toast?.info?.('Восстанавливаем звонок в группе…');
      try {
        void fn(initialSavedGroupCall.group, { withVideo: !!initialSavedGroupCall.withVideo });
      } catch {
        /* */
      }
    }, 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, selfUser?.id, initialSavedGroupCall]);

  // --- Audio-pipeline resume при возврате во вкладку --------------------
  // Та же история, что и в useCall: фоновая вкладка → AudioContext
  // suspended → MediaStreamDestination отдаёт тишину → пиры перестают нас
  // слышать, при этом мы их слышим спокойно (их аудио не зависит от нашего
  // ctx). Явно резюмируем по visibility/focus/pageshow.
  useEffect(() => {
    if (state === 'idle') return undefined;
    const tryResume = () => {
      const pipeline = micPipelineRef.current;
      const ctx = pipeline?.context;
      if (!ctx) return;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {
          /* нет user activation — попробуем позже */
        });
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') tryResume();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', tryResume);
    window.addEventListener('pageshow', tryResume);
    tryResume();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', tryResume);
      window.removeEventListener('pageshow', tryResume);
    };
  }, [state]);

  return {
    state,
    group,
    callId,
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
    join,
    leave,
    toggleMute,
    toggleDeafen,
    toggleCamera,
    toggleScreenShare,
  };
}
