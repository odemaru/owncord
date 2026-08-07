// Аудио-цепочка для исходящего микрофона:
//   [RNNoise?] → HighPass → Compressor → NoiseGate → MakeupGain.
//
// Зачем: «сырое» аудио из getUserMedia передаёт всё, что слышит микрофон —
// гул вентилятора, удары по клавиатуре, эхо комнаты, неровные пики голоса.
// Web Audio API даёт нам набор узлов, которыми можно построить тот же
// сценарий, что в OBS: HP отрезает низкочастотный шум, компрессор
// выравнивает громкость, шумовые ворота гасят паузы, makeup-gain
// возвращает потерянный уровень.
//
// RNNoise (опциональная первая ступень): нейросетевой шумодав, гасит
// клавиатуру/вентилятор/детский крик/уличный шум на уровень ниже того,
// что вытягивает классический gate. Включается флагом aiNoiseSuppression
// (см. пресет «Агрессивный»). Грузит WASM ~150 КБ при первом включении.
//
// Важно: AudioContext должен быть в running-состоянии. Если его
// создавать после async-цепочки (accept→getUserMedia), он может прийти
// suspended, и MediaStreamDestination отдаёт «немой» трек — это и был
// баг прошлой версии (см. комментарий в media.ts). Поэтому createMicPipeline
// явно вызывает ctx.resume() и ждёт, пока контекст реально стартует.

export type AudioFilterSettings = {
  // Сейчас не используется (резерв) — общий выключатель цепочки.
  enabled?: boolean;

  // Громкость на входе (до фильтров) — это inputVolume из настроек.
  inputVolume?: number; // 0..2

  // High-pass: вырезает низкочастотный шум (гул, вентилятор, бубнение).
  // 80–120 Hz — типовые значения; ниже 80 идёт основа мужского голоса.
  highPassEnabled?: boolean;
  highPassFrequency?: number; // Hz, 20..400

  // DynamicsCompressor: выравнивает разницу между громкими/тихими местами.
  // Параметры повторяют OBS-овский Compressor.
  compressorEnabled?: boolean;
  compressorThreshold?: number; // dB, -100..0
  compressorRatio?: number; // 1..20
  compressorAttack?: number; // ms, 0..1000
  compressorRelease?: number; // ms, 0..1000
  compressorKnee?: number; // dB, 0..40

  // Шумовые ворота: ниже порога звук режется в ноль. Сделаны на GainNode
  // с RMS-детектором, опрашиваемым в rAF — для голосового чата хватает.
  noiseGateEnabled?: boolean;
  noiseGateThreshold?: number; // dB, -100..0
  // Hangover: сколько держать ворота открытыми после падения сигнала ниже
  // порога. Без этого ворота моргают на согласных и паузах между словами.
  noiseGateHoldMs?: number;
  // Время плавного открытия/закрытия — анти-кликовое сглаживание.
  noiseGateAttackMs?: number;
  noiseGateReleaseMs?: number;

  // Make-up gain после компрессора (компенсация просадки уровня).
  makeupGainDb?: number; // dB

  // AI-шумодав первой ступенью. Если true, createMicPipeline попробует
  // поднять нейросетевую ступень перед остальной цепочкой. Загрузка
  // асинхронна: если упадёт (offline, блокировка CSP, отсутствие
  // AudioWorklet) — пайплайн тихо обойдётся без AI и продолжит работу.
  aiNoiseSuppression?: boolean;

  // Какой движок использовать под AI-шумодав:
  //   'fastenhancer' — FastEnhancer (ICASSP 2026), по умолчанию. Свежая
  //                    модель, на слух ближе всего к Krisp/Discord.
  //   'rnnoise'      — RNNoise (2018). Легче, но заметно слабее давит
  //                    нестационарный шум (речь на фоне, клавиатура).
  // При 'fastenhancer' RNNoise остаётся автоматическим резервом: если
  // FastEnhancer не поднялся, ступень собирается на RNNoise.
  // См. utils/audioFastEnhancer.ts и utils/audioRnnoise.ts.
  aiEngine?: 'fastenhancer' | 'rnnoise';

  // Размер модели FastEnhancer: 'tiny' | 'base' | 'small'.
  // 'small' (по умолчанию) — лучшее качество, ~36% бюджета кадра.
  // 'base'/'tiny' — для слабых машин и мобилок.
  aiModelSize?: 'tiny' | 'base' | 'small';
};

export type MicPipeline = {
  // Трек для отправки в RTCPeerConnection.
  outputTrack: MediaStreamTrack;
  // Стрим, из которого можно взять outputTrack для localStream.
  outputStream: MediaStream;
  // Сырой стрим (закрепляем, чтобы getUserMedia-источник не GC-ился пока
  // pipeline жив). Останавливать НЕ надо — это сделает pipeline.destroy().
  rawStream: MediaStream;
  // AudioContext, созданный для пайплайна (используется ещё и для метра).
  context: AudioContext;
  // Анализатор после всей цепочки — для UI-метра уровня.
  analyser: AnalyserNode;
  // Полностью разобрать пайплайн (дисконнект узлов, остановка треков, close ctx).
  destroy: () => void;
  // Применить новые настройки к работающей цепочке без её пересборки.
  updateSettings: (next: AudioFilterSettings) => void;
  // Какая AI-ступень фактически поднялась. Не то же самое, что запрошено
  // в настройках: при провале загрузки здесь будет 'rnnoise' (резерв) или
  // 'off'. UI показывает это в настройках звука, чтобы юзер понимал,
  // работает шумодав или молча отвалился.
  aiEngine: 'fastenhancer' | 'rnnoise' | 'off';
};

// Дефолты на случай отсутствия настроек. Подобраны под обычный голосовой
// чат: умеренный HP, компрессор «как в OBS» (ratio 4, threshold -24),
// мягкие ворота на -55 dB (ниже комнатного фона, но выше тишины).
export const DEFAULT_AUDIO_FILTERS: Required<
  Omit<AudioFilterSettings, 'enabled' | 'inputVolume'>
> & {
  enabled: boolean;
  inputVolume: number;
} = {
  enabled: true,
  inputVolume: 1.0,
  highPassEnabled: true,
  highPassFrequency: 100,
  compressorEnabled: true,
  compressorThreshold: -24,
  compressorRatio: 4,
  compressorAttack: 5,
  compressorRelease: 50,
  compressorKnee: 30,
  // Ворота выключены — см. обоснование у STANDARD_PRESET ниже.
  noiseGateEnabled: false,
  noiseGateThreshold: -55,
  noiseGateHoldMs: 350,
  noiseGateAttackMs: 2,
  noiseGateReleaseMs: 200,
  makeupGainDb: 0,
  // AI-шумодав включён по умолчанию: это главное, что отличает звук
  // от «сырого микрофона», и ради него сюда и приходят. Отключить
  // можно пресетом «Выкл» или тумблером в настройках звука.
  aiNoiseSuppression: true,
  aiEngine: 'fastenhancer' as const,
  aiModelSize: 'small' as const,
};

function clampNumber(value: any, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

function mergeSettings(s: AudioFilterSettings | undefined): typeof DEFAULT_AUDIO_FILTERS {
  const d = DEFAULT_AUDIO_FILTERS;
  if (!s) return { ...d };
  return {
    enabled: s.enabled !== false,
    inputVolume: clampNumber(s.inputVolume, 0, 2, d.inputVolume),
    highPassEnabled: s.highPassEnabled !== false,
    highPassFrequency: clampNumber(s.highPassFrequency, 20, 400, d.highPassFrequency),
    compressorEnabled: s.compressorEnabled !== false,
    compressorThreshold: clampNumber(s.compressorThreshold, -100, 0, d.compressorThreshold),
    compressorRatio: clampNumber(s.compressorRatio, 1, 20, d.compressorRatio),
    compressorAttack: clampNumber(s.compressorAttack, 0, 1000, d.compressorAttack),
    compressorRelease: clampNumber(s.compressorRelease, 0, 1000, d.compressorRelease),
    compressorKnee: clampNumber(s.compressorKnee, 0, 40, d.compressorKnee),
    noiseGateEnabled: s.noiseGateEnabled !== false,
    noiseGateThreshold: clampNumber(s.noiseGateThreshold, -100, 0, d.noiseGateThreshold),
    noiseGateHoldMs: clampNumber(s.noiseGateHoldMs, 0, 2000, d.noiseGateHoldMs),
    noiseGateAttackMs: clampNumber(s.noiseGateAttackMs, 0, 500, d.noiseGateAttackMs),
    noiseGateReleaseMs: clampNumber(s.noiseGateReleaseMs, 0, 1000, d.noiseGateReleaseMs),
    makeupGainDb: clampNumber(s.makeupGainDb, -20, 20, d.makeupGainDb),
    // Отсутствующий флаг = дефолт (включено). Явный false — выключаем.
    aiNoiseSuppression: s.aiNoiseSuppression !== false,
    aiEngine: s.aiEngine === 'rnnoise' ? 'rnnoise' : d.aiEngine,
    aiModelSize:
      s.aiModelSize === 'tiny' || s.aiModelSize === 'base' ? s.aiModelSize : d.aiModelSize,
  };
}

/**
 * Построить pipeline обработки исходящего микрофона.
 *
 * Цепочка:
 *   sourceNode → inputGain → highPass → compressor → gateGain → makeupGain → analyser → destination
 *                                                       ▲
 *                                       gateAnalyser (siphon до gateGain'а)
 *                                       └── rAF-цикл считает RMS и
 *                                           двигает gateGain.gain (0/1
 *                                           с плавными переходами).
 *
 * @param rawStream  результат getUserMedia (содержит хотя бы 1 audio-track).
 * @param settings   текущие настройки фильтров (берутся из контекста настроек).
 *
 * Возвращает MicPipeline. Если в браузере нет AudioContext или нет
 * аудио-трека — кидает Error: вызывающий код должен fallback'нуться на
 * сырой track (см. captureLocalMedia).
 */
export async function createMicPipeline(
  rawStream: MediaStream,
  settings?: AudioFilterSettings,
): Promise<MicPipeline> {
  const Ctx: any = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctx) throw new Error('AudioContext not supported');

  const audioTracks = rawStream.getAudioTracks();
  if (!audioTracks.length) throw new Error('No audio tracks in source stream');

  // ВАЖНО: ставим mergeSettings ДО создания контекста — нам нужно знать,
  // включён ли RNNoise, чтобы выбрать sampleRate. RNNoise хочет ровно
  // 48 kHz; для остальной цепочки sample rate не важен (Web Audio API
  // ресэмплирует прозрачно). Ставим 48000 ТОЛЬКО когда AI запрошен,
  // чтобы у юзеров без AI ничего не менялось (любые риски ресэмплинга
  // никого не задевают).
  let s = mergeSettings(settings);

  // Создаём контекст и СРАЗУ резюмируем — иначе MediaStreamDestination
  // может отдать «немой» track. resume() в click-цепочке (start/accept/join)
  // подхватывает sticky activation страницы и завершается успешно.
  let ctx: AudioContext;
  try {
    ctx = s.aiNoiseSuppression
      ? new Ctx({ latencyHint: 'interactive', sampleRate: 48000 })
      : new Ctx({ latencyHint: 'interactive' });
  } catch (e) {
    // Старый Safari: бросает, если sampleRate не родной для устройства.
    // Падаем на дефолтный конструктор и просто отключаем AI для этого
    // сеанса (RNNoise всё равно не заработает не на 48 kHz).
    console.warn('AudioContext({sampleRate:48000}) failed; disabling AI:', e);
    ctx = new Ctx({ latencyHint: 'interactive' });
    s = { ...s, aiNoiseSuppression: false };
  }
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      // Не критично: продолжим, но возможно с задержкой старта семплов.
    }
  }

  // AI-ступень (опционально, самая первая) ------------------------------
  //
  // Порядок попыток: FastEnhancer → RNNoise → без AI. Каждая ступень
  // грузится асинхронно и возвращает null при любой проблеме, поэтому
  // деградация тихая: звонок состоится в любом случае, максимум без
  // шумодава.
  //
  // Две ступени устроены по-разному, и это принципиально для схемы
  // подключения:
  //   * FastEnhancer отдаёт stream-in → stream-out (внутри у него свой
  //     AudioWorkletNode + MediaStreamDestination), поэтому головой
  //     остальной цепочки становится MediaStreamSource от ЕГО выхода.
  //   * RNNoise отдаёт обычный AudioNode, который просто вставляется
  //     между source и inputGain.
  let feStage: import('./audioFastEnhancer').FastEnhancerStage | null = null;
  let rnnoiseNode: any = null;
  let aiEngine: MicPipeline['aiEngine'] = 'off';

  if (s.aiNoiseSuppression) {
    if (s.aiEngine === 'fastenhancer') {
      try {
        const { createFastEnhancerStage } = await import('./audioFastEnhancer');
        feStage = await createFastEnhancerStage(ctx, rawStream, s.aiModelSize);
        if (feStage) aiEngine = 'fastenhancer';
      } catch (e) {
        console.warn('FastEnhancer unavailable, trying RNNoise:', e);
      }
    }
    // Резерв: либо явно выбран RNNoise, либо FastEnhancer не поднялся.
    if (!feStage) {
      try {
        const { createRnnoiseNode } = await import('./audioRnnoise');
        rnnoiseNode = await createRnnoiseNode(ctx);
        if (rnnoiseNode) aiEngine = 'rnnoise';
      } catch (e) {
        console.warn('RNNoise unavailable, falling back to plain pipeline:', e);
      }
    }
  }

  // Узлы цепочки -------------------------------------------------------
  // Голова цепочки: выход FastEnhancer'а, если он поднялся, иначе сырой мик.
  const source = ctx.createMediaStreamSource(feStage ? feStage.outputStream : rawStream);

  const inputGain = ctx.createGain();
  inputGain.gain.value = s.inputVolume;

  const highPass = ctx.createBiquadFilter();
  highPass.type = 'highpass';
  highPass.Q.value = 0.7; // Butterworth-подобная характеристика, без всплеска
  highPass.frequency.value = s.highPassEnabled ? s.highPassFrequency : 20;

  const compressor = ctx.createDynamicsCompressor();
  if (s.compressorEnabled) {
    compressor.threshold.value = s.compressorThreshold;
    compressor.ratio.value = s.compressorRatio;
    compressor.attack.value = s.compressorAttack / 1000;
    compressor.release.value = s.compressorRelease / 1000;
    compressor.knee.value = s.compressorKnee;
  } else {
    // Прозрачный compressor: высокий threshold + ratio=1 = нет эффекта.
    compressor.threshold.value = 0;
    compressor.ratio.value = 1;
    compressor.attack.value = 0.005;
    compressor.release.value = 0.05;
    compressor.knee.value = 0;
  }

  // Шумовые ворота: GainNode, целевое значение которого выставляется
  // RMS-детектором (gateAnalyser). Плавные переходы через linearRamp,
  // чтобы не было щелчков на открытии/закрытии.
  const gateGain = ctx.createGain();
  gateGain.gain.value = 1;

  // Отдельный analyser ДО gateGain — измеряем уровень после компрессора,
  // чтобы порог ворот соответствовал уровню, который услышит собеседник.
  const gateAnalyser = ctx.createAnalyser();
  gateAnalyser.fftSize = 1024;
  gateAnalyser.smoothingTimeConstant = 0.6;

  const makeupGain = ctx.createGain();
  makeupGain.gain.value = dbToLinear(s.makeupGainDb);

  // Финальный analyser после всей цепочки — для UI-метра.
  const finalAnalyser = ctx.createAnalyser();
  finalAnalyser.fftSize = 1024;
  finalAnalyser.smoothingTimeConstant = 0.4;

  const destination = ctx.createMediaStreamDestination();

  // Соединяем -------------------------------------------------------
  // Если RNNoise загрузился — он становится первой ступенью:
  //   source → rnnoise → inputGain → ...
  // Иначе классическая цепочка:
  //   source → inputGain → ...
  if (rnnoiseNode) {
    source.connect(rnnoiseNode as AudioNode);
    (rnnoiseNode as AudioNode).connect(inputGain);
  } else {
    source.connect(inputGain);
  }
  inputGain.connect(highPass);
  highPass.connect(compressor);
  compressor.connect(gateGain);
  compressor.connect(gateAnalyser); // siphon для детектора уровня
  gateGain.connect(makeupGain);
  makeupGain.connect(finalAnalyser);
  finalAnalyser.connect(destination);

  // Носитель «текущих» настроек, мутируется через updateSettings; rAF-цикл
  // читает оттуда без замыкания на старые значения.
  const live = { s };

  // RMS-детектор для ворот (rAF). Если ворота выключены — gainTarget=1 всегда.
  const buf = new Float32Array(gateAnalyser.fftSize);
  // Стартуем «открытыми». При lastAboveTs=0 первая же проверка видела
  // разницу в миллионы миллисекунд, считала ворота закрытыми, и первое
  // слово после входа в звонок съедалось целиком.
  let lastAboveTs = performance.now();
  let rafId = 0;
  let cancelled = false;

  const tick = () => {
    if (cancelled) return;
    const cs = live.s;
    // Окно свёрнуто или вкладка в фоне — requestAnimationFrame встаёт.
    // Детектор при этом замирает в последнем состоянии, и если он замер
    // закрытым, человека не слышно ВООБЩЕ, пока он не вернёт окно в
    // фокус. Симптом со стороны: «говорит, а звука ноль».
    //
    // В фоне гейтить нечем и незачем — держим ворота открытыми, шум
    // всё равно снимает нейросеть. Проверяем на каждом тике, потому что
    // последний тик перед заморозкой должен оставить gain=1.
    const hidden = typeof document !== 'undefined' && document.hidden;
    if (cs.noiseGateEnabled && !hidden) {
      gateAnalyser.getFloatTimeDomainData(buf as any);
      let sum = 0;
      for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const db = rms > 0 ? 20 * Math.log10(rms) : -100;
      const now = performance.now();
      if (db >= cs.noiseGateThreshold) {
        lastAboveTs = now;
      }
      const open = now - lastAboveTs <= cs.noiseGateHoldMs;
      const targetGain = open ? 1 : 0;
      const currentGain = gateGain.gain.value;
      // Плавный переход — без него на открытии/закрытии слышен щелчок.
      if (currentGain !== targetGain) {
        const rampMs = open ? cs.noiseGateAttackMs : cs.noiseGateReleaseMs;
        const t = ctx.currentTime + Math.max(0.001, rampMs / 1000);
        try {
          gateGain.gain.cancelScheduledValues(ctx.currentTime);
          gateGain.gain.setValueAtTime(currentGain, ctx.currentTime);
          gateGain.gain.linearRampToValueAtTime(targetGain, t);
        } catch {
          /* */
        }
      }
    } else {
      // Ворота выключены — держим gain=1 без ramp'ов.
      const v = gateGain.gain.value;
      if (v !== 1) {
        try {
          gateGain.gain.cancelScheduledValues(ctx.currentTime);
          gateGain.gain.setValueAtTime(1, ctx.currentTime);
        } catch {
          /* */
        }
      }
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  // Проверки внутри tick недостаточно: к моменту, когда окно скрыли, rAF
  // уже мог перестать вызываться, и ворота остались бы закрытыми
  // навсегда. Открываем их явно по событию — оно приходит независимо от
  // кадров отрисовки.
  const onVisibility = () => {
    if (!document.hidden) {
      // Вернулись — не даём воротам захлопнуться на первом же слове.
      lastAboveTs = performance.now();
      return;
    }
    try {
      gateGain.gain.cancelScheduledValues(ctx.currentTime);
      gateGain.gain.setValueAtTime(1, ctx.currentTime);
    } catch {
      /* */
    }
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  const outputStream = destination.stream;
  // Берём ссылку на трек один раз — она стабильна.
  const outputTrack = outputStream.getAudioTracks()[0];
  if (!outputTrack) {
    // Ультра-редкий случай (сразу остановили браузер?) — fallback.
    cancelled = true;
    cancelAnimationFrame(rafId);
    try {
      ctx.close();
    } catch {
      /* */
    }
    throw new Error('Failed to create processed audio track');
  }

  // Если raw mic-трек закончится (юзер выдернул USB-микрофон, sleep'нулась
  // вкладка), нам надо аккуратно «погасить» processed-трек, иначе пир будет
  // получать тишину «навсегда». Для звонка это всё равно конец — оставим
  // решение вызывающему коду (он услышит ended на raw track).
  // Здесь только страхуемся, чтобы pipeline не упал.

  const updateSettings: MicPipeline['updateSettings'] = (next) => {
    const merged = mergeSettings({ ...live.s, ...next });
    // Внимание: AI-ступень (aiNoiseSuppression / aiEngine / aiModelSize)
    // тут НЕ перецепить — она фиксируется в момент создания pipeline'а
    // (нужен async-import WASM, регистрация AudioWorklet и контекст на
    // 48 kHz). Вызывающий код должен сверяться с needsPipelineRebuild()
    // и пересобирать цепочку, когда эти поля изменились.
    live.s = merged;
    // Аккуратно применяем — некоторые AudioParam требуют setValueAtTime.
    try {
      const now = ctx.currentTime;
      inputGain.gain.setValueAtTime(merged.inputVolume, now);
      highPass.frequency.setValueAtTime(
        merged.highPassEnabled ? merged.highPassFrequency : 20,
        now,
      );
      if (merged.compressorEnabled) {
        compressor.threshold.setValueAtTime(merged.compressorThreshold, now);
        compressor.ratio.setValueAtTime(merged.compressorRatio, now);
        compressor.attack.setValueAtTime(merged.compressorAttack / 1000, now);
        compressor.release.setValueAtTime(merged.compressorRelease / 1000, now);
        compressor.knee.setValueAtTime(merged.compressorKnee, now);
      } else {
        compressor.threshold.setValueAtTime(0, now);
        compressor.ratio.setValueAtTime(1, now);
      }
      makeupGain.gain.setValueAtTime(dbToLinear(merged.makeupGainDb), now);
    } catch {
      /* AudioParam validation — игнор, попробуем на след. тике */
    }
  };

  const destroy: MicPipeline['destroy'] = () => {
    cancelled = true;
    cancelAnimationFrame(rafId);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
    try {
      source.disconnect();
    } catch {
      /* */
    }
    if (feStage) {
      // Освобождает WASM-память и внутренний AudioWorkletNode. Наш
      // AudioContext ступень НЕ закрывает — он передан ей снаружи
      // (см. audioFastEnhancer.ts, п.2 в шапке файла).
      try {
        feStage.destroy();
      } catch {
        /* */
      }
    }
    if (rnnoiseNode) {
      try {
        (rnnoiseNode as any).disconnect?.();
      } catch {
        /* */
      }
      // У RnnoiseWorkletNode из @sapphi-red есть свой destroy(), который
      // освобождает WASM-память внутри worklet'а. Без него worklet
      // тихо утекает по 0.5 МБ/звонок.
      try {
        (rnnoiseNode as any).destroy?.();
      } catch {
        /* */
      }
    }
    try {
      inputGain.disconnect();
    } catch {
      /* */
    }
    try {
      highPass.disconnect();
    } catch {
      /* */
    }
    try {
      compressor.disconnect();
    } catch {
      /* */
    }
    try {
      gateAnalyser.disconnect();
    } catch {
      /* */
    }
    try {
      gateGain.disconnect();
    } catch {
      /* */
    }
    try {
      makeupGain.disconnect();
    } catch {
      /* */
    }
    try {
      finalAnalyser.disconnect();
    } catch {
      /* */
    }
    try {
      destination.disconnect();
    } catch {
      /* */
    }
    // Сам outputTrack останавливать не нужно — он закончится при close().
    try {
      outputTrack.stop();
    } catch {
      /* */
    }
    // Останавливаем raw-треки, чтобы освободить микрофон.
    for (const t of rawStream.getTracks()) {
      try {
        t.stop();
      } catch {
        /* */
      }
    }
    try {
      ctx.close();
    } catch {
      /* */
    }
  };

  return {
    outputTrack,
    outputStream,
    rawStream,
    context: ctx,
    analyser: finalAnalyser,
    destroy,
    updateSettings,
    aiEngine,
  };
}

/**
 * Нужно ли пересобирать пайплайн при переходе от одних настроек к другим.
 *
 * Большинство параметров (пороги, частоты, gain'ы) применяются на лету
 * через updateSettings. Но AI-ступень фиксируется в момент создания:
 * ей нужен async-import WASM, регистрация AudioWorklet и контекст ровно
 * на 48 kHz. Поэтому смена движка, размера модели или самого флага
 * шумодава требует полной пересборки цепочки.
 *
 * Вызывающий код (useCall / useGroupCall / тест микрофона) должен на
 * true пересоздать pipeline и заменить трек в RTC через replaceTrack.
 */
export function needsPipelineRebuild(
  prev: AudioFilterSettings | undefined,
  next: AudioFilterSettings | undefined,
): boolean {
  const a = mergeSettings(prev);
  const b = mergeSettings(next);
  return (
    a.aiNoiseSuppression !== b.aiNoiseSuppression ||
    a.aiEngine !== b.aiEngine ||
    a.aiModelSize !== b.aiModelSize
  );
}

// =============================================================================
// Микшер «микрофон + системный звук стрима»
// =============================================================================
//
// Зачем нужен:
//   У RTCPeerConnection в нашей схеме ровно один audio-sender (одна
//   m-секция в SDP). Если при включении демонстрации экрана со звуком
//   тупо replaceTrack(audioSender, screenAudioTrack), голос пира перестаёт
//   доходить — это и был баг "стрим со звуком ⇒ меня не слышно".
//
// Что делает:
//   Открывает свой AudioContext, подсоединяет туда два source'а — мик
//   (уже после нашей обработки HighPass→Compressor→Gate→MakeupGain)
//   и системный звук стрима — каждый со своим Gain-узлом, и сводит их
//   в один MediaStreamDestination. Получившийся audio-track ставится
//   на тот же audio-sender и заменяет одиночный мик-трек.
//
// Громкости:
//   - micGain = 1.0 (без изменений; компрессор уже выровнял уровень).
//   - screenGain = 0.7 — лёгкий ducking системного звука: голос должен
//     пробиваться через музыку/игру. Discord использует похожее значение
//     (~0.5..0.7) по умолчанию. Параметризуется на случай, если кому-то
//     надо иначе.
//
// Жизненный цикл:
//   Возвращённый destroy() остановит outputTrack и закроет AudioContext.
//   Сами входные треки (mic/screen) НЕ останавливаются — ими владеет тот,
//   кто передал их сюда.

export type MicScreenMixer = {
  outputTrack: MediaStreamTrack;
  destroy: () => void;
};

export function createMicScreenMixer(opts: {
  micTrack: MediaStreamTrack;
  screenAudioTrack: MediaStreamTrack;
  micGain?: number;
  screenGain?: number;
}): MicScreenMixer {
  const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctx) {
    // Браузер не умеет Web Audio (древние мобилки) — отдаём screen-audio
    // как есть и теряем голос. Это плохо, но альтернативы нет; в реальной
    // практике все таргеты OwnCord поддерживают AudioContext.
    return {
      outputTrack: opts.screenAudioTrack,
      destroy: () => {
        /* */
      },
    };
  }
  const ctx: AudioContext = new Ctx({ latencyHint: 'interactive' });
  // Контекст ОБЯЗАН перейти в 'running'. Прежний комментарий тут
  // допускал, что 'suspended' не страшен и трек всё равно живой — это
  // неверно: приостановленный контекст не рендерит граф, и на выходе
  // MediaStreamDestination идёт тишина. А поскольку через этот микшер
  // проходит не только звук экрана, но и голос, собеседник переставал
  // слышать говорящего вообще, стоило включить демонстрацию со звуком.
  //
  // Гарантию даёт ключ autoplay-policy=no-user-gesture-required в
  // desktop/main.js (в браузере активация обычно уже есть). Здесь —
  // диагностика на случай, если он потеряется: молчаливое пропадание
  // голоса искать крайне тяжело.
  ctx.resume()
    .then(() => {
      if (ctx.state !== 'running') {
        console.warn(
          '[micScreenMixer] AudioContext state=' +
            ctx.state +
            ' — голос и звук экрана не пойдут собеседнику',
        );
      }
    })
    .catch((e) => {
      console.warn('[micScreenMixer] ctx.resume() не удался:', e);
    });

  const micSource = ctx.createMediaStreamSource(new MediaStream([opts.micTrack]));
  const screenSource = ctx.createMediaStreamSource(new MediaStream([opts.screenAudioTrack]));

  const micGainNode = ctx.createGain();
  micGainNode.gain.value = opts.micGain ?? 1.0;
  const screenGainNode = ctx.createGain();
  screenGainNode.gain.value = opts.screenGain ?? 0.7;

  const dest = ctx.createMediaStreamDestination();
  micSource.connect(micGainNode).connect(dest);
  screenSource.connect(screenGainNode).connect(dest);

  const outputTrack = dest.stream.getAudioTracks()[0];

  const destroy = () => {
    try {
      micSource.disconnect();
    } catch {
      /* */
    }
    try {
      screenSource.disconnect();
    } catch {
      /* */
    }
    try {
      micGainNode.disconnect();
    } catch {
      /* */
    }
    try {
      screenGainNode.disconnect();
    } catch {
      /* */
    }
    try {
      dest.disconnect();
    } catch {
      /* */
    }
    try {
      outputTrack?.stop();
    } catch {
      /* */
    }
    try {
      ctx.close();
    } catch {
      /* */
    }
  };

  return { outputTrack, destroy };
}

// =============================================================================
// Пресеты обработки микрофона
// =============================================================================
//
// Цель: дать юзеру три понятных кнопки вместо десяти ползунков, как в Discord.
//
// Контракт:
// - Каждый пресет — это набор значений для тех же самых ключей в settings,
//   что и раньше (highPassFilter, compressorEnabled, noiseSuppression и т.д.).
//   То есть пайплайн audioProcessing вообще не знает о существовании пресетов;
//   мы просто записываем нужные числа в общий settings, как если бы юзер
//   сам выкрутил каждый ползунок.
// - Поле `micFilterPreset` в settings — это лишь подсказка для UI: какой
//   пресет показать как «активный». Если значения отдельных ключей перестают
//   совпадать ни с одним пресетом, UI помечает выбор как 'custom'.
// - 'custom' нельзя «применить» — это терминальное состояние «юзер всё
//   докрутил вручную»; SettingsPanel при выборе любого реального пресета
//   просто перезапишет все ключи разом (см. applyMicFilterPreset).
//
// Если в будущем добавим RNNoise (или любую AI-шумодавку), пресет
// «Агрессивный» включит и её тоже — но сами по себе пресеты к этому коду
// никак не привязаны и могут жить независимо.

export type MicFilterPreset = 'off' | 'standard' | 'aggressive' | 'custom';

// Только те ключи, которые реально записываются пресетом. Не лезем
// в inputVolume/inputDeviceId — это юзер выбирает сам.
type PresetPayload = {
  highPassFilter: boolean;
  highPassFrequency: number;
  compressorEnabled: boolean;
  compressorThreshold: number;
  compressorRatio: number;
  compressorAttack: number;
  compressorRelease: number;
  compressorKnee: number;
  noiseSuppression: boolean;
  noiseThreshold: number;
  noiseGateHoldMs: number;
  noiseGateAttackMs: number;
  noiseGateReleaseMs: number;
  makeupGainDb: number;
  // AI-шумодав. Включён и в «Стандарте», и в «Агрессивном» — это база
  // современного голосового чата, а не опция для энтузиастов. Разница
  // между пресетами теперь в классической части цепочки (gate/компрессор),
  // а не в наличии нейросети. Выключается только пресетом «Выкл».
  aiNoiseSuppression: boolean;
};

// Эти три значения должны совпадать с DEFAULTS в SettingsContext, иначе
// при открытии настроек UI будет показывать «Пользовательский» сразу
// после установки. Если меняешь дефолты — синхронизируй и тут.
const STANDARD_PRESET: PresetPayload = {
  highPassFilter: true,
  highPassFrequency: 100,
  compressorEnabled: true,
  compressorThreshold: -24,
  compressorRatio: 4,
  compressorAttack: 5,
  compressorRelease: 50,
  compressorKnee: 30,
  // Шумовые ворота ВЫКЛЮЧЕНЫ. Их работу теперь делает нейросеть, причём
  // без побочного эффекта: ворота — это грубый порог по громкости, они
  // не отличают тихую речь от шума и рубят начала фраз, концы слов и
  // короткие реплики целиком. Именно на это жаловались все — «говорит,
  // а половина слов не доходит».
  //
  // Оставить их «на всякий случай» нельзя: две системы подавления в
  // цепочке дают ровно ту потерю слогов, ради устранения которой всё и
  // затевалось. Кому нужен именно порог (очень шумная комната, AI не
  // тянет по процессору) — включает вручную или берёт «Агрессивный».
  noiseSuppression: false,
  noiseThreshold: -55,
  // Атака 2 мс вместо 10: даже когда ворота включают вручную, они не
  // должны срезать атаку первого слога.
  noiseGateHoldMs: 350,
  noiseGateAttackMs: 2,
  noiseGateReleaseMs: 200,
  makeupGainDb: 0,
  aiNoiseSuppression: true,
};

// «Выкл» — полностью прозрачная цепочка. Юзер либо пользуется
// внешним софтом (OBS / Krisp / VoiceMeeter), либо у него очень
// чистый микрофон и любая обработка только мешает.
const OFF_PRESET: PresetPayload = {
  highPassFilter: false,
  highPassFrequency: 100,
  compressorEnabled: false,
  compressorThreshold: -24,
  compressorRatio: 4,
  compressorAttack: 5,
  compressorRelease: 50,
  compressorKnee: 30,
  noiseSuppression: false,
  noiseThreshold: -55,
  noiseGateHoldMs: 350,
  noiseGateAttackMs: 2,
  noiseGateReleaseMs: 200,
  makeupGainDb: 0,
  aiNoiseSuppression: false,
};

// «Агрессивный» = AI-шумодав + жёсткий gate + сильный compressor.
// Для шумных комнат / клавиатур / соседей за стеной. Нейросеть сама
// справляется с большинством шумов; gate и compressor оставлены на тот
// случай, если AI-ступень не загрузилась (offline / CSP / старый
// браузер) — без них в этом сценарии было бы выключено всё.
//
// HP: 120 Гц. Раньше здесь стояло 400 Гц, и это была главная причина,
// почему «Агрессивный» звучал как телефонная трубка: основной тон
// мужского голоса лежит на 85–180 Гц, женского — на 165–255 Гц, то есть
// срез на 400 Гц выносил фундаментальную частоту целиком и оставлял одни
// гармоники. 120 Гц глушит гул и вентилятор, но голос не трогает.
const AGGRESSIVE_PRESET: PresetPayload = {
  highPassFilter: true,
  highPassFrequency: 120,
  compressorEnabled: true,
  compressorThreshold: -28,
  compressorRatio: 6,
  compressorAttack: 3,
  compressorRelease: 60,
  compressorKnee: 24,
  // Ворота здесь остаются — это и отличает «Агрессивный». Но пороги
  // смягчены: −45 дБ отсекал тихую речь наравне с шумом, а удержание
  // 150 мс захлопывало их между словами в обычном темпе разговора.
  noiseSuppression: true,
  noiseThreshold: -58,
  noiseGateHoldMs: 400,
  noiseGateAttackMs: 2,
  noiseGateReleaseMs: 250,
  makeupGainDb: 0,
  aiNoiseSuppression: true,
};

const PRESET_MAP: Record<Exclude<MicFilterPreset, 'custom'>, PresetPayload> = {
  off: OFF_PRESET,
  standard: STANDARD_PRESET,
  aggressive: AGGRESSIVE_PRESET,
};

/**
 * Возвращает payload пресета для записи в settings. Для 'custom'
 * возвращает null — кастом нельзя «применить» (это просто метка).
 */
export function getMicFilterPreset(name: MicFilterPreset): PresetPayload | null {
  if (name === 'custom') return null;
  return PRESET_MAP[name] ?? null;
}

/**
 * Сравнивает текущий settings с известными пресетами и возвращает имя
 * совпавшего; если ни один не подходит — 'custom'. Числовые поля
 * сравниваются с небольшим эпсилоном на случай float-погрешностей
 * после localStorage round-trip'а.
 */
export function detectMicFilterPreset(settings: any): MicFilterPreset {
  if (!settings || typeof settings !== 'object') return 'standard';
  const keys = Object.keys(STANDARD_PRESET) as (keyof PresetPayload)[];
  for (const presetName of ['off', 'standard', 'aggressive'] as const) {
    const preset = PRESET_MAP[presetName];
    let match = true;
    for (const k of keys) {
      const expected = preset[k];
      const actual = settings[k];
      // Если в settings ключ ещё не задан — считаем, что значение
      // равно дефолту 'standard' (это и так живёт в DEFAULTS).
      const a = actual === undefined ? STANDARD_PRESET[k] : actual;
      if (typeof expected === 'boolean') {
        if (Boolean(a) !== expected) {
          match = false;
          break;
        }
      } else {
        if (typeof a !== 'number' || Math.abs(a - (expected as number)) > 0.001) {
          match = false;
          break;
        }
      }
    }
    if (match) return presetName;
  }
  return 'custom';
}

/**
 * Возвращает объект для передачи в update(): значения пресета +
 * сам ключ micFilterPreset. Удобно, чтобы в одном setSettings
 * перезаписать всё разом.
 */
export function applyMicFilterPreset(name: Exclude<MicFilterPreset, 'custom'>) {
  const payload = getMicFilterPreset(name);
  if (!payload) return { micFilterPreset: name };
  return { ...payload, micFilterPreset: name };
}

/**
 * Извлечь срез настроек фильтров из общего объекта settings. Полезно,
 * чтобы в одном месте знать «какие ключи относятся к аудио-цепочке».
 */
export function pickAudioFilterSettings(settings: any): AudioFilterSettings {
  if (!settings || typeof settings !== 'object') return {};
  return {
    enabled: settings.audioFiltersEnabled,
    inputVolume: settings.inputVolume,
    highPassEnabled: settings.highPassFilter,
    highPassFrequency: settings.highPassFrequency,
    compressorEnabled: settings.compressorEnabled,
    compressorThreshold: settings.compressorThreshold,
    compressorRatio: settings.compressorRatio,
    compressorAttack: settings.compressorAttack,
    compressorRelease: settings.compressorRelease,
    compressorKnee: settings.compressorKnee,
    noiseGateEnabled: settings.noiseSuppression,
    noiseGateThreshold: settings.noiseThreshold,
    noiseGateHoldMs: settings.noiseGateHoldMs,
    noiseGateAttackMs: settings.noiseGateAttackMs,
    noiseGateReleaseMs: settings.noiseGateReleaseMs,
    makeupGainDb: settings.makeupGainDb,
    aiNoiseSuppression: settings.aiNoiseSuppression,
    aiEngine: settings.aiEngine,
    aiModelSize: settings.aiModelSize,
  };
}
