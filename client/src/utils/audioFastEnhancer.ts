// AI-шумодав на базе FastEnhancer (ICASSP 2026) — нейросетевая модель
// подавления шума, скомпилированная в C → WASM SIMD. Пришла на замену
// RNNoise (2018) как основная ступень: та же схема «AudioWorklet + WASM»,
// но заметно более свежая архитектура (FFT → Encoder → RNNFormer →
// Decoder → iFFT) и на слух ближе к тому, что делает Krisp в Discord.
//
// RNNoise остаётся резервом: если FastEnhancer не загрузился (старый
// браузер, зарезанный CSP, отвалившийся WASM), createMicPipeline сам
// откатится на audioRnnoise.ts, а если и он не поднялся — на цепочку
// без AI вообще. См. createMicPipeline в audioProcessing.ts.
//
// Архитектурные решения, зашитые здесь:
//
//  1) Пакет отдаёт stream-in → stream-out, а не голый AudioNode:
//     createStreamDenoiser внутри сам делает
//     source → AudioWorkletNode → MediaStreamDestination.
//     Поэтому ступень возвращает `outputStream`, а вызывающий код
//     строит из него `ctx.createMediaStreamSource(...)` как голову
//     остальной цепочки. Своего AudioWorkletNode пакет наружу не
//     отдаёт, а лезть в его внутренний протокол сообщений — заведомо
//     хрупко, поэтому используем публичный API.
//
//  2) Контекст ПЕРЕДАЁМ свой. В опциях есть `audioContext` — при его
//     наличии пакет помечает контекст как чужой (_ownsAudioContext =
//     false) и не закрывает его в destroy(). Это критично: контекст
//     принадлежит пайплайну, в нём же живут highPass/compressor/gate,
//     и его закрытие уронило бы всю цепочку.
//
//  3) FastEnhancer работает строго на 48 kHz (hop 512 сэмплов,
//     бюджет кадра 10.67 мс). Контекст создаётся с явным
//     sampleRate=48000 в createMicPipeline; если по факту частота
//     другая — возвращаем null и уходим в fallback, иначе модель
//     получит неверный темп и звук поедет.
//
//  4) Динамический import() самого пакета: WASM и веса вшиты в JS как
//     base64, и тянуть их в главный бандл незачем. Vite вынесет в
//     отдельный chunk, который грузится при первом включении шумодава.
//
//  5) Модели: tiny / base / small (28K / 101K / 207K параметров,
//     124 / 391 / 780 КБ gzip). По умолчанию 'small' — лучшее качество
//     подавления при загрузке ядра ~36% от бюджета кадра. Для слабых
//     машин UI может передать 'base' или 'tiny'.

export type FastEnhancerModel = 'tiny' | 'base' | 'small';

export type FastEnhancerStage = {
  // Очищенный поток. Из него вызывающий код делает MediaStreamSource.
  outputStream: MediaStream;
  // Временно пропустить звук мимо модели (без пересборки пайплайна).
  setBypass: (bypass: boolean) => void;
  // true, если worklet сам ушёл в passthrough из-за нехватки CPU
  // (5 подряд пропущенных кадров). Полезно показать в UI.
  isAutoBypassed: () => boolean;
  destroy: () => void;
};

// Кэш загруженной модели по размеру. Сам пакет тоже кэширует loadModel,
// но держим свой слой, чтобы не платить за динамический import каждый раз.
const modelCache = new Map<FastEnhancerModel, Promise<any | null>>();

/**
 * Загрузить (и закэшировать) модель нужного размера. Возвращает null,
 * если окружение не тянет — вызывающий код обязан это проверить.
 */
function ensureModel(size: FastEnhancerModel): Promise<any | null> {
  let p = modelCache.get(size);
  if (!p) {
    p = (async () => {
      try {
        // Без AudioWorklet ступень невозможна в принципе.
        if (typeof AudioWorkletNode === 'undefined') return null;
        const mod = await import('fastenhancer-web');
        // diagnose() проверяет wasm/simd/audioContext/audioWorklet разом.
        // При отсутствии SIMD пакет сам падает на скалярную сборку, так
        // что нас интересует только общий вердикт.
        const support = await mod.isSupported();
        if (!support?.wasm || !support?.audioWorklet) return null;
        // baseUrl не передаём — WASM и веса вшиты в JS как base64
        // (zero-config): не нужно раздавать .wasm со статики и возиться
        // с CORS/MIME на nginx.
        return await mod.loadModel(size);
      } catch (e) {
        console.warn('FastEnhancer model load failed:', e);
        return null;
      }
    })();
    modelCache.set(size, p);
  }
  return p;
}

/**
 * Построить ступень шумоподавления поверх сырого микрофонного потока.
 *
 * @param ctx        AudioContext пайплайна. ДОЛЖЕН быть на 48 kHz.
 * @param rawStream  результат getUserMedia (нужен хотя бы один audio-track).
 * @param size       размер модели; по умолчанию 'small' (лучшее качество).
 *
 * Возвращает null при любой проблеме — это штатный путь, вызывающий код
 * молча уходит на RNNoise или на цепочку без AI.
 */
export async function createFastEnhancerStage(
  ctx: AudioContext,
  rawStream: MediaStream,
  size: FastEnhancerModel = 'small',
): Promise<FastEnhancerStage | null> {
  if (ctx.sampleRate !== 48000) {
    console.warn('FastEnhancer requires sampleRate=48000, got', ctx.sampleRate);
    return null;
  }
  if (!rawStream.getAudioTracks().length) return null;

  const model = await ensureModel(size);
  if (!model) return null;

  try {
    let autoBypassed = false;
    const denoiser = await model.createStreamDenoiser(rawStream, {
      // Свой контекст — пакет его НЕ закроет (см. п.2 в шапке файла).
      audioContext: ctx,
      onWarning: (msg: string) => console.warn('[FastEnhancer]', msg),
      onAutoBypass: (enabled: boolean) => {
        autoBypassed = enabled;
        if (enabled) {
          console.warn('[FastEnhancer] auto-bypass: не укладываемся в бюджет кадра');
        }
      },
    });

    // AGC модели выключаем: у нас дальше по цепочке свой компрессор с
    // makeup-gain, и две автоматики, дерущиеся за уровень, дают «дыхание»
    // громкости. HPF модели, наоборот, оставляем как есть — это её
    // штатная предобработка, а наш highPass стоит уже после и режет
    // по своей частоте.
    try {
      denoiser.agcEnabled = false;
    } catch {
      /* поле может отсутствовать в будущих версиях — не критично */
    }

    return {
      outputStream: denoiser.outputStream,
      setBypass: (bypass: boolean) => {
        try {
          denoiser.bypass = bypass;
        } catch {
          /* */
        }
      },
      isAutoBypassed: () => autoBypassed,
      destroy: () => {
        try {
          denoiser.destroy();
        } catch {
          /* */
        }
      },
    };
  } catch (e) {
    console.warn('Failed to create FastEnhancer stage:', e);
    return null;
  }
}
