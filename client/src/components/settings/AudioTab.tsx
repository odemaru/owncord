// Таб «Звук»: разрешения на медиа, выбор устройств, обработка микрофона
// (HighPass → Compressor → NoiseGate → MakeupGain), пресеты, тест микрофона
// и динамика. Самый длинный таб — единственный, где есть live-pipeline и
// requestAnimationFrame для визуализации уровня.

import { useEffect, useRef, useState } from 'react';
import {
  Mic,
  Volume2,
  Play,
  Sliders,
  Video,
  Activity,
  ChevronDown,
  ChevronRight,
  Sparkles,
  RefreshCw,
  Check,
  Network,
} from 'lucide-react';
import {
  createMicPipeline,
  pickAudioFilterSettings,
  applyMicFilterPreset,
  detectMicFilterPreset,
  type MicFilterPreset,
} from '../../utils/audioProcessing';
import { useSettings } from '../../context/SettingsContext';
import { useToast } from '../../context/ToastContext';
import { PermissionRow, SliderRow, ToggleRow } from './shared';

async function queryPermission(name: string): Promise<string> {
  if (!navigator.permissions?.query) return 'unknown';
  try {
    const result = await navigator.permissions.query({ name: name as PermissionName });
    return result.state || 'unknown';
  } catch {
    return 'unknown';
  }
}

function stopMediaStream(stream: MediaStream | null) {
  stream?.getTracks?.().forEach((track) => {
    try {
      track.stop();
    } catch {
      /* ignore */
    }
  });
}

export function AudioTab() {
  const { settings, update } = useSettings();
  const toast = useToast();
  const [devices, setDevices] = useState<{
    input: MediaDeviceInfo[];
    output: MediaDeviceInfo[];
  }>({ input: [], output: [] });
  const [permissions, setPermissions] = useState({
    microphone: 'unknown',
    camera: 'unknown',
  });
  const [permissionBusy, setPermissionBusy] = useState<string | null>(null);
  const [permissionError, setPermissionError] = useState('');
  const [deviceRefreshKey, setDeviceRefreshKey] = useState(0);
  // micLevel.db — RMS уровень после всей цепочки фильтров (то, что услышит пир).
  // gateOpen — true когда noise gate сейчас пропускает звук (для индикатора).
  const [micLevel, setMicLevel] = useState({ percent: 0, db: -100, gateOpen: false });
  const [isTestingMic, setIsTestingMic] = useState(false);
  const [isTestingSpeaker, setIsTestingSpeaker] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Активный пресет обработки микрофона. Источник истины — реальные значения
  // ползунков; саму метку из settings.micFilterPreset не доверяем, потому что
  // юзер мог покрутить ползунки между сессиями (и она устарела), а defaults
  // могли поменяться при апгрейде. detectMicFilterPreset() сравнивает текущий
  // settings со всеми пресетами и возвращает имя совпавшего или 'custom'.
  const currentPreset: MicFilterPreset = detectMicFilterPreset(settings);
  // Применить пресет = перезаписать пачку ключей одним update'ом.
  const choosePreset = (name: Exclude<MicFilterPreset, 'custom'>) => {
    update(applyMicFilterPreset(name));
    // При выборе «Выкл» расширенный блок не нужен — там нечего настраивать.
    if (name === 'off') setAdvancedOpen(false);
  };
  // Обёртка для индивидуальных ползунков «расширенных параметров»: помечает
  // конфигурацию как 'custom', чтобы UI показал «Пользовательский» и юзер
  // понимал, что у него своя конфигурация (а не один из готовых пресетов).
  const updateAdvanced = (patch: Record<string, any>) => {
    update({ ...patch, micFilterPreset: 'custom' });
  };

  // Pipeline проживает на время теста микрофона. Тут лежат и AudioContext,
  // и MediaStream'ы — pipeline.destroy() сам всё закроет.
  const pipelineRef = useRef<any>(null);
  // Невидимый <audio> для loopback'а: подключаем к outputStream pipeline'а,
  // чтобы юзер слышал ровно то, что услышит собеседник. Echo-cancellation
  // при getUserMedia'е сглаживает риск обратной связи.
  const loopbackAudioRef = useRef<HTMLAudioElement | null>(null);
  const testAudioRef = useRef<{ stop: () => void } | null>(null);

  const canPickOutput =
    typeof HTMLAudioElement !== 'undefined' && 'setSinkId' in HTMLAudioElement.prototype;

  const refreshPermissions = async () => {
    const [microphone, camera] = await Promise.all([
      queryPermission('microphone'),
      queryPermission('camera'),
    ]);
    setPermissions({
      microphone,
      camera,
    });
  };

  useEffect(() => {
    refreshPermissions();
  }, []);

  const requestPermission = async (kind: string) => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia) {
      setPermissionError('Браузер не поддерживает доступ к микрофону и камере.');
      return;
    }
    setPermissionBusy(kind);
    setPermissionError('');
    let stream: MediaStream | null = null;
    try {
      if (kind === 'microphone') {
        stream = await mediaDevices.getUserMedia({ audio: true });
        toast.success('Доступ к микрофону разрешён');
      } else if (kind === 'camera') {
        stream = await mediaDevices.getUserMedia({ video: true });
        toast.success('Доступ к камере разрешён');
      } else if (kind === 'media') {
        stream = await mediaDevices.getUserMedia({ audio: true, video: true });
        toast.success('Доступ к микрофону и камере разрешён');
      }
      stopMediaStream(stream);
      await refreshPermissions();
      setDeviceRefreshKey((n) => n + 1);
    } catch (err: any) {
      stopMediaStream(stream);
      const denied = err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError';
      setPermissionError(
        denied
          ? 'Разрешение отклонено. Если браузер запомнил отказ, включите доступ в настройках сайта.'
          : err?.message || 'Не удалось запросить разрешение.',
      );
      await refreshPermissions();
    } finally {
      setPermissionBusy(null);
    }
  };

  // Визуализация уровня микрофона. Читаем pipeline.analyser, который стоит
  // в самом конце цепочки — то есть видим именно то, что услышит пир.
  // gateOpen вытягиваем из gateGain.gain.value: если ворота закрыты, индикатор
  // погаснет (так юзер на глаз видит, как порог режет паузы).
  useEffect(() => {
    if (!isTestingMic) return undefined;
    const pipeline = pipelineRef.current;
    if (!pipeline) return undefined;
    let raf = 0;
    let cancelled = false;
    const buf = new Float32Array(pipeline.analyser.fftSize);
    const tick = () => {
      if (cancelled) return;
      try {
        pipeline.analyser.getFloatTimeDomainData(buf as any);
        let sum = 0;
        for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        const db = rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
        const percent = Math.min(100, Math.max(0, ((db + 60) / 60) * 100));
        // Грубо «ворота открыты» — если RMS заметно выше порога. Только UI.
        const threshold = settings.noiseThreshold ?? -55;
        const gateOpen = db >= threshold;
        setMicLevel({ percent, db: Math.round(db), gateOpen });
      } catch {
        /* */
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [isTestingMic, settings.noiseThreshold]);

  // Очистка при размонтировании панели — на случай, если юзер закрыл
  // настройки, не остановив тест явно.
  useEffect(() => {
    return () => {
      if (pipelineRef.current) {
        try {
          pipelineRef.current.destroy();
        } catch {
          /* */
        }
        pipelineRef.current = null;
      }
      if (loopbackAudioRef.current) {
        try {
          loopbackAudioRef.current.pause();
        } catch {
          /* */
        }
        try {
          loopbackAudioRef.current.srcObject = null;
        } catch {
          /* */
        }
        loopbackAudioRef.current = null;
      }
    };
  }, []);

  // Прокидывает новые настройки в живой pipeline во время теста.
  // Пользователь крутит ползунки — слышит результат сразу, без рестарта.
  useEffect(() => {
    if (!isTestingMic) return;
    const pipeline = pipelineRef.current;
    if (!pipeline) return;
    try {
      pipeline.updateSettings(pickAudioFilterSettings(settings));
    } catch {
      /* */
    }
  }, [
    isTestingMic,
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

  // Если во время активного теста юзер меняет микрофон в выпадающем
  // списке — рестартим тест на новом устройстве. updateSettings выше
  // не помогает: deviceId фиксируется в getUserMedia при startMicTest,
  // и без рестарта юзер продолжал бы слышать звук со старого мика, что
  // полностью обесценивало бы тест («не слышу разницы между гарнитурой
  // и встроенным микрофоном»).
  useEffect(() => {
    if (!isTestingMic) return undefined;
    // stopMicTest синхронно гасит pipeline + audio-loopback, после чего
    // мелким setTimeout(50ms) даём React один цикл на ре-рендер с
    // isTestingMic=false и стартуем заново. cleanup перебивает таймер,
    // если устройство сменили опять до того, как пере-старт случился.
    stopMicTest();
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      startMicTest();
    }, 50);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.inputDeviceId]);

  const startMicTest = async () => {
    try {
      const audioConstraints: any = {
        deviceId:
          settings.inputDeviceId && settings.inputDeviceId !== 'default'
            ? { exact: settings.inputDeviceId }
            : undefined,
        echoCancellation: true,
        // noiseSuppression на уровне браузера всегда включаем — наш gate
        // работает ПОВЕРХ него, отрезая то, что NS не догасил.
        noiseSuppression: true,
        autoGainControl: true,
      };
      const rawStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
      });
      // Тот же createMicPipeline, что в реальном звонке (см. useCall/useGroupCall).
      // Это гарантирует: что юзер слышит в тесте — то и услышит собеседник.
      const pipeline = await createMicPipeline(rawStream, pickAudioFilterSettings(settings));
      pipelineRef.current = pipeline;

      // Loopback: HTMLAudioElement с outputStream pipeline'а. По умолчанию
      // звук пойдёт в выбранное юзером устройство вывода (см. setSinkId).
      const audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      (audioEl as any).playsInline = true;
      audioEl.srcObject = pipeline.outputStream;
      // Делаем тише, чтобы не вызвать обратную связь с открытыми колонками.
      audioEl.volume = 0.6;
      if (canPickOutput && settings.outputDeviceId && settings.outputDeviceId !== 'default') {
        try {
          await (audioEl as any).setSinkId?.(settings.outputDeviceId);
        } catch {
          /* */
        }
      }
      try {
        await audioEl.play();
      } catch {
        /* autoplay-policy: контекст всё равно живой */
      }
      loopbackAudioRef.current = audioEl;

      setIsTestingMic(true);
    } catch (err) {
      console.error('Mic test error:', err);
      toast.error?.('Не удалось начать тест микрофона. Проверьте разрешения.');
    }
  };

  const stopMicTest = () => {
    if (pipelineRef.current) {
      try {
        pipelineRef.current.destroy();
      } catch {
        /* */
      }
      pipelineRef.current = null;
    }
    if (loopbackAudioRef.current) {
      try {
        loopbackAudioRef.current.pause();
      } catch {
        /* */
      }
      try {
        loopbackAudioRef.current.srcObject = null;
      } catch {
        /* */
      }
      loopbackAudioRef.current = null;
    }
    setMicLevel({ percent: 0, db: -100, gateOpen: false });
    setIsTestingMic(false);
  };

  const testSpeaker = () => {
    if (isTestingSpeaker) {
      testAudioRef.current?.stop();
      testAudioRef.current = null;
      setIsTestingSpeaker(false);
      return;
    }

    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();

    // Используем звук соединения как тест (два тона)
    const osc1 = audioContext.createOscillator();
    const osc2 = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    osc1.connect(gainNode);
    osc2.connect(gainNode);
    gainNode.connect(audioContext.destination);

    osc1.frequency.value = 660; // Первый тон
    osc2.frequency.value = 880; // Второй тон
    osc1.type = 'sine';
    osc2.type = 'sine';
    gainNode.gain.value = (settings.outputVolume ?? 1) * 0.3; // 30% от настроенной громкости

    const now = audioContext.currentTime;
    gainNode.gain.setValueAtTime(0, now);
    gainNode.gain.linearRampToValueAtTime((settings.outputVolume ?? 1) * 0.3, now + 0.01);
    gainNode.gain.linearRampToValueAtTime(0, now + 0.25);

    osc1.start(now);
    osc2.start(now + 0.1);
    osc1.stop(now + 0.25);
    osc2.stop(now + 0.25);

    // Остановить через 0.3 секунды
    setTimeout(() => {
      audioContext.close();
      setIsTestingSpeaker(false);
      testAudioRef.current = null;
    }, 300);

    testAudioRef.current = {
      stop: () => {
        osc1.stop();
        osc2.stop();
      },
    };
    setIsTestingSpeaker(true);
  };

  useEffect(() => {
    let cancelled = false;
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices) return undefined;
    async function loadDevices() {
      try {
        const list = await mediaDevices.enumerateDevices();
        if (cancelled) return;
        const input = list.filter((d) => d.kind === 'audioinput');
        const output = list.filter((d) => d.kind === 'audiooutput');
        setDevices({ input, output });
      } catch {
        /* ignore */
      }
    }
    loadDevices();
    const handler = () => loadDevices();
    mediaDevices.addEventListener?.('devicechange', handler);
    return () => {
      cancelled = true;
      mediaDevices.removeEventListener?.('devicechange', handler);
    };
  }, [deviceRefreshKey]);

  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <label className="text-xs text-slate-400 uppercase tracking-wider">Разрешения</label>
        <div className="rounded-lg border border-border bg-bg-2 divide-y divide-border">
          <PermissionRow
            icon={<Mic size={16} />}
            title="Микрофон"
            description="Нужен для голосовых сообщений и звонков"
            status={permissions.microphone}
            busy={permissionBusy === 'microphone' || permissionBusy === 'media'}
            onRequest={() => requestPermission('microphone')}
          />
          <PermissionRow
            icon={<Video size={16} />}
            title="Камера"
            description="Нужна для видеозвонков"
            status={permissions.camera}
            busy={permissionBusy === 'camera' || permissionBusy === 'media'}
            onRequest={() => requestPermission('camera')}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-primary h-9 px-3 text-xs disabled:opacity-50"
            onClick={() => requestPermission('media')}
            disabled={!!permissionBusy}
          >
            {permissionBusy === 'media' ? 'Запрашиваем…' : 'Разрешить микрофон и камеру'}
          </button>
          <button
            type="button"
            className="btn-ghost h-9 px-3 text-xs"
            onClick={() => {
              refreshPermissions();
              setDeviceRefreshKey((n) => n + 1);
            }}
            disabled={!!permissionBusy}
          >
            <RefreshCw size={12} className="mr-1" />
            Обновить
          </button>
        </div>
        {permissionError && <div className="text-xs text-amber-300">{permissionError}</div>}
      </div>

      <div className="h-px bg-border" />

      <div className="space-y-1.5">
        <label className="text-xs text-slate-400 uppercase tracking-wider">
          Микрофон (исходящий)
        </label>
        <select
          className="input"
          value={settings.inputDeviceId || 'default'}
          onChange={(e) => update({ inputDeviceId: e.target.value })}
        >
          <option value="default">По умолчанию</option>
          {devices.input.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Устройство ${d.deviceId.slice(0, 6)}`}
            </option>
          ))}
        </select>
        <SliderRow
          icon={<Mic size={14} className="text-slate-400" />}
          value={Math.round((settings.inputVolume ?? 1) * 100)}
          min={0}
          max={200}
          step={5}
          unit="%"
          onChange={(v) => update({ inputVolume: v / 100 })}
        />

        {/* Визуализация уровня микрофона */}
        {isTestingMic && (
          <div className="pt-2">
            <div className="flex items-center gap-2 mb-1">
              <div className="flex-1 h-2 bg-bg-3 rounded-full overflow-hidden relative">
                <div
                  className={`h-full transition-all duration-75 ${
                    micLevel.gateOpen ? 'bg-emerald-500' : 'bg-slate-500'
                  }`}
                  style={{ width: `${((micLevel.db + 100) / 100) * 100}%` }}
                />
                {/* Маркер порога ворот */}
                {settings.noiseSuppression !== false && (
                  <div
                    className="absolute top-0 h-full w-0.5 bg-red-400"
                    style={{ left: `${(((settings.noiseThreshold ?? -55) + 100) / 100) * 100}%` }}
                    title={`Порог ворот: ${settings.noiseThreshold ?? -55} дБ`}
                  />
                )}
              </div>
              <span className="text-xs text-slate-400 w-20 text-right tabular-nums">
                {micLevel.db} дБ
              </span>
            </div>
            <div className="text-[10px] text-slate-500">
              {micLevel.gateOpen
                ? 'Ворота открыты — звук идёт собеседнику'
                : `Ниже порога ${settings.noiseThreshold ?? -55} дБ — пир сейчас слышит тишину`}
            </div>
          </div>
        )}

        {/* Кнопка проверки микрофона */}
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={isTestingMic ? stopMicTest : startMicTest}
            className={`btn-ghost h-8 px-3 text-xs ${isTestingMic ? 'text-red-400' : ''}`}
          >
            {isTestingMic ? 'Остановить тест' : 'Проверить микрофон'}
          </button>
          {isTestingMic && (
            <span className="text-[11px] text-slate-500">
              Вы должны слышать свой голос через динамики
            </span>
          )}
        </div>

        <div className="text-[11px] text-slate-500">
          Смена микрофона применится к следующему звонку.
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs text-slate-400 uppercase tracking-wider">
          Динамик / наушники (входящий)
        </label>
        {canPickOutput ? (
          <select
            className="input"
            value={settings.outputDeviceId || 'default'}
            onChange={(e) => update({ outputDeviceId: e.target.value })}
          >
            <option value="default">По умолчанию</option>
            {devices.output.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Устройство ${d.deviceId.slice(0, 6)}`}
              </option>
            ))}
          </select>
        ) : (
          <div className="text-xs text-slate-500">
            Выбор устройства вывода не поддерживается этим браузером.
          </div>
        )}
        <SliderRow
          icon={<Volume2 size={14} className="text-slate-400" />}
          value={Math.round((settings.outputVolume ?? 1) * 100)}
          min={0}
          max={100}
          step={1}
          unit="%"
          onChange={(v) => update({ outputVolume: v / 100 })}
        />

        {/* Кнопка проверки динамика */}
        <div className="flex items-center gap-2 pt-1">
          <button type="button" onClick={testSpeaker} className="btn-ghost h-8 px-3 text-xs">
            <Play size={12} className="mr-1" />
            {isTestingSpeaker ? 'Остановить тест' : 'Тест динамика'}
          </button>
        </div>
      </div>

      <div className="space-y-3">
        <label className="text-xs text-slate-400 uppercase tracking-wider">
          Обработка микрофона
        </label>
        <div className="text-[11px] text-slate-500 -mt-1.5">
          Выберите готовый профиль или откройте расширенные параметры, чтобы настроить цепочку
          HighPass → Compressor → NoiseGate → MakeupGain вручную. Кнопка «Проверить микрофон»
          воспроизводит ровно тот же результат, что услышит собеседник.
        </div>

        {/* Пресеты обработки. Клик по карточке — это choosePreset(): он
            одним update'ом перезаписывает все ключи цепочки разом
            (см. applyMicFilterPreset в audioProcessing.ts). */}
        <div className="grid grid-cols-3 gap-2">
          <PresetCard
            active={currentPreset === 'off'}
            title="Выкл"
            subtitle="Сырой микрофон"
            description="Без обработки. Используйте, если у вас уже есть OBS, Krisp или внешний шумодав."
            onClick={() => choosePreset('off')}
          />
          <PresetCard
            active={currentPreset === 'standard'}
            title="Стандарт"
            subtitle="Рекомендуется"
            description="Срез низов + лёгкий компрессор + ворота от шёпота. Подходит большинству."
            onClick={() => choosePreset('standard')}
          />
          <PresetCard
            active={currentPreset === 'aggressive'}
            title="Агрессивный"
            subtitle="AI-шумодав (RNNoise)"
            description="Нейросеть гасит клавиатуру/вентилятор/фон комнаты + жёсткий gate и компрессор. Загружает ~150 КБ WASM при первом включении."
            onClick={() => choosePreset('aggressive')}
          />
        </div>
        {currentPreset === 'custom' && (
          <div className="text-[11px] text-amber-300/80 flex items-center gap-1.5">
            <Sliders size={12} />
            Пользовательский профиль (значения отличаются от пресетов)
          </div>
        )}

        {/* Раскрывашка с экспертными параметрами. По умолчанию закрыта,
            чтобы UI оставался простым; внутри — все старые ползунки.
            При любом изменении updateAdvanced пометит конфигурацию как
            'custom' (см. выше). При выбранном «Выкл» прятать раскрывашку
            нет смысла — пусть юзер всё равно увидит, как «выглядит выключено». */}
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200"
        >
          {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {advancedOpen ? 'Скрыть' : 'Показать'} расширенные параметры
        </button>
        {advancedOpen && (
          <div className="space-y-3 pt-1">
            {/* AI noise suppression (RNNoise) ---------------------- */}
            {/* Эта ступень — первая в цепочке. WASM грузится lazy при
                первом запуске пайплайна со включённым флагом, потом
                кэшируется на всё приложение. Если загрузка падает,
                createMicPipeline молча падает на цепочку без AI. */}
            <ToggleRow
              title="AI-шумодав (RNNoise)"
              description="Нейросеть гасит клавиатуру, вентилятор, фон комнаты. ~150 КБ WASM, требует AudioWorklet (Chrome 80+/Firefox 76+/Safari 14.1+)."
              icon={<Sparkles size={16} />}
              checked={settings.aiNoiseSuppression === true}
              onChange={(v) => updateAdvanced({ aiNoiseSuppression: v })}
            />

            {/* High-pass --------------------------------------------- */}
            <ToggleRow
              title="Высокочастотный фильтр"
              description="Срезает низкочастотный гул (вентилятор, гудение, бубнение в стол)"
              icon={<Sliders size={16} />}
              checked={settings.highPassFilter !== false}
              onChange={(v) => updateAdvanced({ highPassFilter: v })}
            />
            {settings.highPassFilter !== false && (
              <div className="pl-7">
                <label className="text-[11px] text-slate-500">Частота среза</label>
                <SliderRow
                  icon={null}
                  value={settings.highPassFrequency ?? 100}
                  min={20}
                  max={400}
                  step={5}
                  unit=" Гц"
                  onChange={(v) => updateAdvanced({ highPassFrequency: v })}
                />
              </div>
            )}

            {/* Compressor -------------------------------------------- */}
            <ToggleRow
              title="Компрессор"
              description="Выравнивает громкость: тихое подтягивает, громкое прижимает (как в OBS / Discord)"
              icon={<Activity size={16} />}
              checked={settings.compressorEnabled !== false}
              onChange={(v) => updateAdvanced({ compressorEnabled: v })}
            />
            {settings.compressorEnabled !== false && (
              <div className="pl-7 space-y-2">
                <div>
                  <label className="text-[11px] text-slate-500">Порог (threshold)</label>
                  <SliderRow
                    icon={null}
                    value={settings.compressorThreshold ?? -24}
                    min={-60}
                    max={0}
                    step={1}
                    unit=" дБ"
                    onChange={(v) => updateAdvanced({ compressorThreshold: v })}
                  />
                </div>
                <div>
                  <label className="text-[11px] text-slate-500">Степень сжатия (ratio)</label>
                  <SliderRow
                    icon={null}
                    value={settings.compressorRatio ?? 4}
                    min={1}
                    max={20}
                    step={0.5}
                    unit=":1"
                    onChange={(v) => updateAdvanced({ compressorRatio: v })}
                  />
                </div>
                <div>
                  <label className="text-[11px] text-slate-500">Атака</label>
                  <SliderRow
                    icon={null}
                    value={settings.compressorAttack ?? 5}
                    min={0}
                    max={100}
                    step={1}
                    unit=" мс"
                    onChange={(v) => updateAdvanced({ compressorAttack: v })}
                  />
                </div>
                <div>
                  <label className="text-[11px] text-slate-500">Спад (release)</label>
                  <SliderRow
                    icon={null}
                    value={settings.compressorRelease ?? 50}
                    min={0}
                    max={500}
                    step={5}
                    unit=" мс"
                    onChange={(v) => updateAdvanced({ compressorRelease: v })}
                  />
                </div>
                <div>
                  <label className="text-[11px] text-slate-500">Перегиб (knee)</label>
                  <SliderRow
                    icon={null}
                    value={settings.compressorKnee ?? 30}
                    min={0}
                    max={40}
                    step={1}
                    unit=" дБ"
                    onChange={(v) => updateAdvanced({ compressorKnee: v })}
                  />
                </div>
              </div>
            )}

            {/* Noise gate -------------------------------------------- */}
            <ToggleRow
              title="Шумовые ворота (gate)"
              description="Полностью режет звук между фразами, когда вы молчите"
              icon={<Mic size={16} />}
              checked={settings.noiseSuppression !== false}
              onChange={(v) => updateAdvanced({ noiseSuppression: v })}
            />
            {settings.noiseSuppression !== false && (
              <div className="pl-7 space-y-2">
                <div>
                  <label className="text-[11px] text-slate-500">Порог открытия ворот</label>
                  <SliderRow
                    icon={null}
                    value={settings.noiseThreshold ?? -55}
                    min={-100}
                    max={0}
                    step={1}
                    unit=" дБ"
                    onChange={(v) => updateAdvanced({ noiseThreshold: v })}
                  />
                </div>
                <div>
                  <label className="text-[11px] text-slate-500">
                    Hangover ворот (как долго держать открытыми после паузы)
                  </label>
                  <SliderRow
                    icon={null}
                    value={settings.noiseGateHoldMs ?? 200}
                    min={0}
                    max={1000}
                    step={10}
                    unit=" мс"
                    onChange={(v) => updateAdvanced({ noiseGateHoldMs: v })}
                  />
                </div>
                <div>
                  <label className="text-[11px] text-slate-500">
                    Атака ворот (плавность открытия)
                  </label>
                  <SliderRow
                    icon={null}
                    value={settings.noiseGateAttackMs ?? 10}
                    min={0}
                    max={200}
                    step={1}
                    unit=" мс"
                    onChange={(v) => updateAdvanced({ noiseGateAttackMs: v })}
                  />
                </div>
                <div>
                  <label className="text-[11px] text-slate-500">
                    Спад ворот (плавность закрытия)
                  </label>
                  <SliderRow
                    icon={null}
                    value={settings.noiseGateReleaseMs ?? 80}
                    min={0}
                    max={500}
                    step={5}
                    unit=" мс"
                    onChange={(v) => updateAdvanced({ noiseGateReleaseMs: v })}
                  />
                </div>
              </div>
            )}

            <div>
              <label className="text-[11px] text-slate-500">Make-up gain (после компрессора)</label>
              <SliderRow
                icon={null}
                value={settings.makeupGainDb ?? 0}
                min={-12}
                max={12}
                step={0.5}
                unit=" дБ"
                onChange={(v) => updateAdvanced({ makeupGainDb: v })}
              />
            </div>
          </div>
        )}
      </div>

      <div className="h-px bg-border" />

      {/* Сеть и соединение. forceTurnRelay — спасательный круг для юзеров
          за симметричным NAT/CGNAT: ICE через STUN иногда «зеленеет», но
          реальный RTP не доезжает, и звук пропадает у обоих. Принудительный
          relay через TURN решает это ценой задержки и трафика, поэтому
          по дефолту off. */}
      <div className="space-y-2">
        <label className="text-xs text-slate-400 uppercase tracking-wider">Соединение</label>
        <div className="rounded-lg border border-border bg-bg-2 p-3 space-y-3">
          <ToggleRow
            icon={<Network size={16} />}
            title="Принудительно через TURN (relay)"
            description="Включай, если в звонках тишина у обоих, хотя соединение «установилось». Гонит медиа-трафик через relay-сервер — обходит симметричный NAT и мобильный CGNAT. Цена: чуть выше задержка."
            checked={!!settings.forceTurnRelay}
            onChange={(v) => update({ forceTurnRelay: v })}
          />
          <div className="h-px bg-border/60" />
          {/* «Сырой микрофон» — спасательный круг для Electron-десктопа,
              где AudioContext periodически уходит в suspended после
              async-цепочки getUserMedia и MediaStreamDestination отдаёт
              немой трек. Тест микро использует тот же pipeline и работает
              (resume() в одном тике user-click), а звонок ломается.
              Выключение тогла = в RTC уходит сырой track из getUserMedia,
              без AudioContext-обёртки → пир гарантированно вас слышит,
              но без HighPass/Compressor/Gate. */}
          <ToggleRow
            icon={<Mic size={16} />}
            title="Применять фильтры микрофона"
            description="Если собеседник вас не слышит (особенно в десктопе), выключите. Микрофон пойдёт сырым, без HighPass/Compressor/Gate — пир гарантированно вас услышит, но обработка не применится."
            checked={settings.audioFiltersEnabled !== false}
            onChange={(v) => update({ audioFiltersEnabled: v })}
          />
        </div>
        <div className="text-[11px] text-slate-500 leading-snug">
          Диагностика: открой DevTools (Ctrl+Shift+I) → Console во время
          звонка. Каждые 3 сек выводятся записи <code>[rtc-diag …]</code>
          с типом ICE-кандидата (host/srflx/relay) и счётчиками RTP-пакетов.
        </div>
      </div>
    </section>
  );
}

// Карточка пресета микрофона. Намеренно простая: заголовок, подзаголовок,
// краткое описание; активная карточка обводится акцентом и подсвечивается.
// Эту мелочь не выносим в отдельный файл — она нужна только тут.
function PresetCard({
  active,
  title,
  subtitle,
  description,
  onClick,
}: {
  active: boolean;
  title: string;
  subtitle: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-lg border p-3 transition-colors h-full
        ${
          active
            ? 'border-accent bg-accent/10 text-white'
            : 'border-border bg-bg-2 hover:bg-bg-3 text-slate-200'
        }`}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="text-sm font-medium">{title}</div>
        {active && <Check size={14} className="text-accent" />}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mb-1.5">{subtitle}</div>
      <div className="text-[11px] text-slate-400 leading-snug">{description}</div>
    </button>
  );
}
