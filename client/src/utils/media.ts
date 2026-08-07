// Утилиты для WebRTC-медиа: placeholder-треки и обёртка getUserMedia.
//
// Главная цель — гарантировать, что у каждого RTCPeerConnection
// при создании ВСЕГДА есть реальный audio и video MediaStreamTrack,
// даже если пользователь не включил камеру. Это даёт SDP с msid+ssrc
// с первого offer/answer, а значит:
//   • track сразу появляется на стороне пира через ontrack;
//   • `replaceTrack` потом просто заменяет содержимое sender'а
//     (включение камеры / демонстрации экрана) без renegotiation
//     и без танцев с пере-fire'ингом ontrack.
//
// Без placeholder-ов пустой transceiver(`addTransceiver('video', sendrecv)`)
// в Chrome не даёт ontrack у пира при последующем replaceTrack — это и
// был корень бага «caller не видит экран callee».

let blackCanvasStreamCache = null;

function getBlackCanvasStream() {
  if (blackCanvasStreamCache) return blackCanvasStreamCache;
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 320, 180);
  // Ключ: канва регулярно «перерисовывается» (хотя и тем же
  // чёрным цветом). Это держит captureStream-track в active state
  // и заставляет кодер регулярно генерировать keyframe-ы. Без
  // этого после replaceTrack(real) пир не получает кадры до
  // очередного PLI/keyframe — зритель видит чёрный экран.
  blackCanvasStreamCache = canvas.captureStream(15);
  setInterval(() => {
    ctx.fillRect(0, 0, 320, 180);
  }, 200);
  return blackCanvasStreamCache;
}

// Видео-плейсхолдер: чёрный кадр 320×180 @15fps. enabled=true,
// чтобы encoder pipeline был прогрет (для пира это «alive»-трек с
// keyframe-ами), и после replaceTrack на real screen/camera кадры
// начинают доходить до пира сразу, без ожидания keyframe.
export function createPlaceholderVideoTrack() {
  const stream = getBlackCanvasStream();
  // Клонируем, чтобы stop() на одном PC не убил track для других.
  const track = stream.getVideoTracks()[0].clone();
  return track;
}

// Аудио-плейсхолдер: тихий oscillator c gain=0. Track всегда disabled.
// AudioContext создаётся ленив только когда нужен, и обязательно после
// user gesture (мы вызываем эту функцию из обработчиков клика).
let placeholderAudioCtxCache = null;

function getPlaceholderAudioContext() {
  if (placeholderAudioCtxCache) return placeholderAudioCtxCache;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  placeholderAudioCtxCache = new Ctx();
  // Если контекст suspended — попытаемся возобновить, но молча.
  if (placeholderAudioCtxCache.state === 'suspended') {
    placeholderAudioCtxCache.resume().catch(() => {
      /* */
    });
  }
  return placeholderAudioCtxCache;
}

export function createPlaceholderAudioTrack() {
  const ctx = getPlaceholderAudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0;
  const dst = ctx.createMediaStreamDestination();
  osc.connect(gain).connect(dst);
  try {
    osc.start();
  } catch {
    /* */
  }
  const t = dst.stream.getAudioTracks()[0];
  // enabled=true и gain=0: encoder отправляет тихие фреймы, RTP-пайплайн
  // жив, sender SSRC активен. После replaceTrack(real mic) пир сразу
  // начинает слышать, без паузы на переинициализацию.
  return t;
}

// Простой захват микрофона/камеры. Возвращает MediaStream без какой-либо
// дополнительной обработки. Раньше мы прогоняли аудио через AudioContext
// (gain), но это вызывало одностороннюю связь, когда контекст начинал
// жизнь в suspended-состоянии после async-цепочки accept(): пир получал
// трек, но без сэмплов. Теперь трек идёт сырым из getUserMedia.
//
// ВАЖНО про этот абзац: на него ссылались как на доказательство того, что
// в Electron трек от MediaStreamDestination вообще не доходит до пира, и
// на этом основании в десктопе отключили весь микрофонный пайплайн вместе
// с шумодавом. Утверждение шире, чем факт. Проблема была в suspended-
// контексте, а не в MediaStreamDestination как таковом: замеры на Windows
// и macOS (Electron 42.8.1, см. tools/rtc-audio-probe) показывают, что
// путь mic -> Web Audio -> dest -> RTC работает. Пайплайн включён обратно
// везде; от suspended-контекста защищает watchdog в useCall/useGroupCall.
//
// Если сохранённый deviceId больше не существует (другая машина,
// другой профиль браузера), Chrome бросает OverconstrainedError —
// отлавливаем и fallback'имся на «default»-источник, иначе юзер будет
// «немым» без видимых причин.
// aiNoiseSuppression — работает ли наша нейросетевая ступень (FastEnhancer /
// RNNoise) в пайплайне. Если да, браузерный noiseSuppression НУЖНО
// выключить: WebRTC-шумодав (NS3 от Google) стоит до нашей цепочки, и две
// подавлялки подряд дают «жёваный», «подводный» звук — модель обучалась на
// естественном шуме, а получает уже покоцанный NS3 сигнал с музыкальными
// артефактами. Discord поступает так же: при включённом Krisp нативный NS
// отключается. echoCancellation, наоборот, оставляем всегда — AEC решает
// принципиально другую задачу (эхо от собственных динамиков), и шумодав
// его не заменяет.
export async function captureLocalMedia({
  wantVideo = false,
  audioDeviceId = null,
  aiNoiseSuppression = false,
} = {}) {
  const baseAudio = {
    echoCancellation: true,
    noiseSuppression: !aiNoiseSuppression,
    autoGainControl: true,
  };
  const video = wantVideo
    ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }
    : false;

  const tryGet = (audio) => navigator.mediaDevices.getUserMedia({ audio, video });

  if (audioDeviceId && audioDeviceId !== 'default') {
    try {
      return await tryGet({ ...baseAudio, deviceId: { exact: audioDeviceId } });
    } catch (e) {
      // Устройство пропало — пробуем без deviceId.
      if (e?.name === 'OverconstrainedError' || e?.name === 'NotFoundError') {
        return tryGet(baseAudio);
      }
      throw e;
    }
  }
  return tryGet(baseAudio);
}

// Пресеты для getDisplayMedia + setParameters на video sender'е.
// max-bitrate подобран так, чтобы картинка оставалась читабельной
// (текст не «разъезжался» при движении), но не забивал канал.
// Битрейт у 60fps-вариантов выше не вдвое, а примерно в полтора раза:
// соседние кадры при удвоенной частоте сильно похожи, и межкадровое
// сжатие съедает часть разницы. Полное удвоение просто жгло бы канал без
// выигрыша в качестве.
export const SCREEN_PRESETS = {
  '480p': { width: 854, height: 480, frameRate: 30, maxBitrate: 1_500_000, label: '480p · 30fps' },
  '720p': { width: 1280, height: 720, frameRate: 30, maxBitrate: 3_000_000, label: '720p · 30fps' },
  '720p60': {
    width: 1280,
    height: 720,
    frameRate: 60,
    maxBitrate: 4_500_000,
    label: '720p · 60fps',
  },
  '1080p': {
    width: 1920,
    height: 1080,
    frameRate: 30,
    maxBitrate: 6_000_000,
    label: '1080p · 30fps',
  },
  '1080p60': {
    width: 1920,
    height: 1080,
    frameRate: 60,
    maxBitrate: 9_000_000,
    label: '1080p · 60fps',
  },
  '1440p': {
    width: 2560,
    height: 1440,
    frameRate: 30,
    maxBitrate: 12_000_000,
    label: '1440p · 30fps (2K)',
  },
  '1440p60': {
    width: 2560,
    height: 1440,
    frameRate: 60,
    maxBitrate: 18_000_000,
    label: '1440p · 60fps (2K)',
  },
};

export const SCREEN_PRESET_KEYS = [
  '480p',
  '720p',
  '720p60',
  '1080p',
  '1080p60',
  '1440p',
  '1440p60',
];

export function getScreenPreset(key) {
  return SCREEN_PRESETS[key] || SCREEN_PRESETS['720p'];
}

// Захватить экран с выбранным пресетом. Chrome обычно отдаёт
// разрешение источника «как есть», но ideal-поля подсказывают браузеру
// верхнюю планку (иначе браузер может скипалировать вниз).
//
// Про звук — важная деталь, из-за которой пользователи спрашивают
// «почему стрим из браузера передаёт звук другого браузера на одном ПК»:
//
//   • При выборе «Окно» (Window) или «Весь экран» (Screen) Chromium на
//     Windows захватывает системный аудио-микшер. Изолировать звук
//     одного приложения от другого через getDisplayMedia невозможно —
//     это ограничение ОС/браузера, не наше.
//   • Чтобы захватить звук ТОЛЬКО одной вкладки/приложения, юзер должен
//     в системном диалоге выбрать «Вкладка» (Tab) и поставить галочку
//     «Поделиться звуком вкладки». Тогда система отдаёт только её аудио.
//
// Мы выставляем максимально качественные ограничения (48k stereo, без AEC),
// чтобы музыка/игры передавались без артефактов, и подсказку
// `systemAudio: 'include'` для Chromium.
export async function captureDisplay(presetKey, includeAudio = false) {
  const preset = getScreenPreset(presetKey);
  // Если просим аудио — задаём «studio»-настройки. Применять
  // echoCancellation/noiseSuppression к системному звуку нельзя, иначе
  // музыка и эффекты будут «жёванные».
  const audio = includeAudio
    ? {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48000,
        channelCount: 2,
      }
    : false;

  /** @type {any} */
  const constraints = {
    video: {
      width: { ideal: preset.width },
      height: { ideal: preset.height },
      frameRate: { ideal: preset.frameRate, max: preset.frameRate },
    },
    audio,
    // Подсказки Chromium 107+: разрешаем юзеру выбрать любую поверхность
    // (вкладку/окно/экран) и переключаться между вкладками во время стрима.
    selfBrowserSurface: 'include',
    surfaceSwitching: 'include',
    // 'include' — намекаем, что хотим системный звук (если пользователь
    // выбирает Tab — это её звук, если Screen — весь системный микшер).
    // Без этого Chromium <115 в части сборок выключает аудио-чекбокс.
    systemAudio: includeAudio ? 'include' : 'exclude',
    // Опциональный флаг (Chrome 109+): не глушит звук в локальных колонках,
    // когда стримим вкладку. Поведение по умолчанию `true` — звук падает
    // только в стрим, и юзер сам себя не слышит. Оставляем дефолт.
  };

  const display = await navigator.mediaDevices.getDisplayMedia(constraints);

  // На десктопе при шеринге ОКНА мы хотим звук ТОЛЬКО этого приложения,
  // а не весь системный микшер. main-процесс уже сделал выбор:
  //
  //   • Если выбрано ОКНО + audio И per-process WASAPI loopback стартовал —
  //     main параллельно с chromium-loopback стримит PCM в IPC. Здесь мы
  //     удаляем chromium audio track (он несёт системный микшер) и
  //     добавляем PCM-track через attachProcessAudioToDisplay.
  //   • Иначе (экран целиком, или per-process loopback не стартовал —
  //     macOS/Linux/окно закрылось) — chromium audio track уже даёт
  //     системный звук, дополнительной обработки не нужно.
  //
  // Внимание: chromium ВСЕГДА даёт audio track при audio:true в callback'е
  // main-а (это требование Electron'а — иначе getDisplayMedia падает,
  // см. desktop/main.js). Поэтому мы не можем просто пропустить audio
  // в getDisplayMedia при шеринге окна — приходится «подменять» track.
  if (includeAudio) {
    const api = (typeof window !== 'undefined' ? window.electronAPI : null) || null;
    let procAudioActive = false;
    try {
      procAudioActive = !!(api?.procAudio && (await api.procAudio.isActive()));
    } catch {
      /* main мог не успеть зарегистрировать handler — не критично */
    }
    if (procAudioActive) {
      // Удаляем системный (chromium) audio из display, освобождаем ресурсы.
      for (const t of display.getAudioTracks()) {
        try {
          display.removeTrack(t);
          t.stop();
        } catch {
          /* */
        }
      }
      await attachProcessAudioToDisplay(display);
    } else if (!api?.procAudio) {
      // Веб-версия (или старая сборка десктопа без procAudio API).
      // У Chromium на Windows при шеринге **окна** с галкой звука нет
      // per-window audio capture: он отдаёт ВЕСЬ системный микшер. Если
      // юзер при этом ожидал «звук этого приложения», результат ему
      // совсем не нужен — и собеседнику тоже (Discord/Spotify/и т.п.
      // польётся в звонок). Срезаем audio track и поднимаем флаг,
      // useCall тостит юзеру про десктоп.
      // Шер «всего экрана» (displaySurface === 'monitor') и «вкладки»
      // (displaySurface === 'browser') трогать не надо: monitor — юзер
      // явно понимает, что делится всем; browser — chromium даёт реальный
      // per-tab audio.
      const videoTrack = display.getVideoTracks()[0];
      // displaySurface — стандартный screen-capture API (chromium 99+).
      const surface = videoTrack && (videoTrack.getSettings() as any).displaySurface;
      const audioTracks = display.getAudioTracks();
      if (surface === 'window' && audioTracks.length > 0) {
        for (const t of audioTracks) {
          try {
            display.removeTrack(t);
            t.stop();
          } catch {
            /* */
          }
        }
        // Метим стрим, чтобы useCall показал toast и не недоумевал
        // насчёт пропавшего audio-track'а после captureDisplay.
        (display as any).windowAudioStripped = true;
      }
    }
  }

  // contentHint — подсказка кодировщику, чем жертвовать при сжатии.
  // Без неё Chromium считает захват экрана статичным текстом и экономит
  // на частоте кадров ради чёткости: 60fps-пресет отдавал бы фактические
  // 20-30 кадров, и разницы с обычным режимом не было бы видно.
  //
  //   'motion' — беречь плавность, допускать мягкость картинки (игры,
  //              видео, всё что движется). Ставим на 60fps-пресетах.
  //   'detail' — беречь резкость, допускать проседание частоты (код,
  //              документы, интерфейсы). Ставим на 30fps.
  const vTrack = display.getVideoTracks()[0];
  if (vTrack && 'contentHint' in vTrack) {
    vTrack.contentHint = preset.frameRate >= 60 ? 'motion' : 'detail';
  }

  return display;
}

// --- Per-process audio (desktop only) ----------------------------------
//
// Когда main-процесс запустил WASAPI process-loopback для целевого окна,
// он шлёт сырой PCM в renderer через IPC 'proc-audio:chunk'. Мы создаём
// здесь маленький аудио-граф:
//
//   AudioWorkletNode (PCM in)  →  MediaStreamAudioDestinationNode (track out)
//
// AudioWorkletNode принимает чанки PCM (Float32, interleaved LRLRLR...)
// через port.postMessage и пишет их в свои outputs планарно. Плеер
// destination'а отдаёт обычный MediaStreamTrack, который мы добавляем
// в displayStream — дальше работает обычный RTP-флоу WebRTC, как для
// 'loopback'-аудио, без изменений в useCall.ts/useGroupCall.ts.

const PROC_AUDIO_WORKLET_SRC = `
class ProcAudioPlayer extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    this._channels = (opts && opts.processorOptions && opts.processorOptions.channels) || 2;
    // Очередь сэмплов на канал. Каждый элемент — Float32Array длины N
    // (frame count). process() сливает их по 128 фреймов (фиксированный
    // размер блока WebAudio). Если данных не хватает — пишем тишину.
    this._buf = [];
    this._bufFrames = 0;
    this.port.onmessage = (e) => {
      const data = e.data;
      if (!data) return;
      if (data.type === 'pcm') {
        // data.frames: Float32Array[channels], каждое — N сэмплов канала.
        this._buf.push(data.frames);
        this._bufFrames += data.frames[0].length;
      } else if (data.type === 'flush') {
        this._buf.length = 0;
        this._bufFrames = 0;
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0];
    const need = out[0].length;  // 128
    let written = 0;
    while (written < need && this._buf.length) {
      const head = this._buf[0];
      const headLen = head[0].length;
      const take = Math.min(headLen, need - written);
      for (let ch = 0; ch < out.length; ch++) {
        const src = head[Math.min(ch, head.length - 1)];
        out[ch].set(src.subarray(0, take), written);
      }
      written += take;
      if (take === headLen) {
        this._buf.shift();
        this._bufFrames -= headLen;
      } else {
        // Остаток в head — отрезаем consumed часть.
        const remaining = [];
        for (let ch = 0; ch < head.length; ch++) {
          remaining.push(head[ch].subarray(take));
        }
        this._buf[0] = remaining;
        this._bufFrames -= take;
      }
    }
    // Тишина в хвост, если не хватило данных.
    for (let ch = 0; ch < out.length; ch++) {
      out[ch].fill(0, written);
    }
    return true;
  }
}
registerProcessor('proc-audio-player', ProcAudioPlayer);
`;

// Кэш URL модуля worklet'а, чтобы не плодить Blob'ы при каждом шеринге.
let _procWorkletUrl = null;
function getProcWorkletUrl() {
  if (_procWorkletUrl) return _procWorkletUrl;
  const blob = new Blob([PROC_AUDIO_WORKLET_SRC], { type: 'application/javascript' });
  _procWorkletUrl = URL.createObjectURL(blob);
  return _procWorkletUrl;
}

/**
 * Конвертирует interleaved Float32 PCM → planar Float32Array[channels].
 * Например, для stereo: [L0, R0, L1, R1, L2, R2, ...] → [[L0, L1, L2], [R0, R1, R2]].
 */
function deinterleaveFloat32(interleaved, channels) {
  const frames = (interleaved.length / channels) | 0;
  const planar = new Array(channels);
  for (let ch = 0; ch < channels; ch++) {
    planar[ch] = new Float32Array(frames);
  }
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channels; ch++) {
      planar[ch][i] = interleaved[i * channels + ch];
    }
  }
  return planar;
}

/**
 * Берёт displayStream (от getDisplayMedia без audio) и, если main активно
 * шлёт per-process loopback, добавляет к нему audio-track из этого PCM.
 *
 * Безопасно вызывать ВНЕ desktop'а / без includeAudio — функция тихо
 * вернётся. Если main не успел стартовать loopback (например, не нашёл
 * PID окна) — chunk-ов просто не будет, audio-track будет тихим
 * (silence), но звонок не сломается.
 *
 * Cleanup:
 *   - Когда video track displayStream'а кончается (юзер нажал "Stop sharing"
 *     в системном баннере или вручную остановил), мы:
 *       a) просим main остановить loopback (procAudio.stop());
 *       b) закрываем AudioContext, отписываемся от IPC, отзываем Blob URL.
 */
async function attachProcessAudioToDisplay(displayStream) {
  const api = (typeof window !== 'undefined' ? window.electronAPI : null) || null;
  if (!api?.procAudio) return; // не desktop / старая сборка
  // Проверим хотя бы factually, что platform поддерживает (на macOS
  // procAudio есть в API, но isSupported() вернёт false). Запрос делаем
  // параллельно с format'ом.
  let format;
  try {
    const [supported, fmt] = await Promise.all([
      api.procAudio.isSupported(),
      api.procAudio.getFormat(),
    ]);
    if (!supported) return;
    format = fmt;
  } catch (e) {
    console.warn('procAudio bootstrap failed:', e);
    return;
  }
  if (!format || !format.sampleRate) return;

  const Ctx = window.AudioContext || (window as any).webkitAudioContext;
  const ctx = new Ctx({ sampleRate: format.sampleRate });

  try {
    await ctx.audioWorklet.addModule(getProcWorkletUrl());
  } catch (e) {
    console.warn('procAudio addModule failed:', e);
    try {
      await ctx.close();
    } catch {
      /* */
    }
    return;
  }

  const node = new AudioWorkletNode(ctx, 'proc-audio-player', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [format.channels],
    processorOptions: { channels: format.channels },
  });
  const dst = ctx.createMediaStreamDestination();
  node.connect(dst);

  // Подписка на чанки. encoding: 'float32' → парсим напрямую,
  // 'int16' → нормируем в [-1, 1].
  const onChunk = (data) => {
    try {
      let interleaved;
      if (format.encoding === 'int16') {
        const i16 = new Int16Array(data.buffer, data.byteOffset, data.byteLength / 2);
        interleaved = new Float32Array(i16.length);
        for (let i = 0; i < i16.length; i++) {
          interleaved[i] = i16[i] / 0x8000;
        }
      } else {
        // float32 little-endian. Если byteOffset не выровнен по 4 —
        // копируем (DataView), иначе zero-copy.
        if ((data.byteOffset & 3) === 0) {
          interleaved = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
        } else {
          const aligned = new ArrayBuffer(data.byteLength);
          new Uint8Array(aligned).set(data);
          interleaved = new Float32Array(aligned);
        }
      }
      const planar = deinterleaveFloat32(interleaved, format.channels);
      // Transferable: у Float32Array.buffer можно передать ownership,
      // экономим копию. Но deinterleaveFloat32 уже отдал свежие
      // буферы — их и transfer'им.
      const transfer = planar.map((p) => p.buffer);
      node.port.postMessage({ type: 'pcm', frames: planar }, transfer);
    } catch (err) {
      // одиночный битый chunk не должен валить весь стрим
      console.warn('procAudio chunk parse failed:', err);
    }
  };
  const offChunk = api.procAudio.onChunk(onChunk);

  // Кладём audio-track в displayStream рядом с video. useCall/useGroupCall
  // сразу подхватят его как обычный screen-audio через display.getAudioTracks()[0].
  const audioTrack = dst.stream.getAudioTracks()[0];
  if (audioTrack) {
    displayStream.addTrack(audioTrack);
  }

  // Cleanup при остановке шеринга. videoTrack.onended срабатывает, когда
  // юзер нажал "прекратить демонстрацию" в нашем UI или в баннере Chromium,
  // или когда целевое окно закрылось.
  const videoTrack = displayStream.getVideoTracks()[0];
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      offChunk();
    } catch {
      /* */
    }
    try {
      api.procAudio.stop();
    } catch {
      /* */
    }
    try {
      audioTrack?.stop();
    } catch {
      /* */
    }
    try {
      node.disconnect();
    } catch {
      /* */
    }
    try {
      ctx.close();
    } catch {
      /* */
    }
  };
  if (videoTrack) {
    videoTrack.addEventListener('ended', cleanup, { once: true });
  }
  // На случай, если main внезапно завершил loopback (ApplicationLoopback.exe
  // умер, целевой процесс закрылся), он шлёт 'proc-audio:ended'. Cleanup'имся,
  // чтобы AudioContext не висел.
  const offEnded = api.procAudio.onEnded(() => {
    try {
      offEnded();
    } catch {
      /* */
    }
    cleanup();
  });
}

// Применить maxBitrate к video sender'у. Без этого WebRTC берёт
// дефолтные ~2–4 Mbps — для 1080p и 1440p это мыло.
export async function applyVideoSenderQuality(sender, presetKey) {
  if (!sender) return;
  const preset = getScreenPreset(presetKey);
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) {
      params.encodings = [{}];
    }
    for (const enc of params.encodings) {
      enc.maxBitrate = preset.maxBitrate;
      enc.maxFramerate = preset.frameRate;
    }
    if ('degradationPreference' in params) {
      // Чем жертвовать, когда канала или процессора не хватает.
      //
      // Для 30fps-пресетов режем частоту и держим разрешение: их выбирают
      // под текст и код, где важна читаемость, а дёрганость терпима.
      //
      // Для 60fps — наоборот. Раньше здесь безусловно стояло
      // 'maintain-resolution', и это сводило бы 60fps на нет: при первой
      // же нехватке канала WebRTC срезал бы именно частоту кадров, то
      // есть ровно то, ради чего пресет и выбирают.
      params.degradationPreference =
        preset.frameRate >= 60 ? 'maintain-framerate' : 'maintain-resolution';
    }
    await sender.setParameters(params);
  } catch {
    /* не критично */
  }
}
