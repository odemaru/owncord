import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

const SettingsContext = createContext(null);

const STORAGE_KEY = 'owncord.settings';

const DEFAULTS = {
  inputDeviceId: 'default', // микрофон
  outputDeviceId: 'default', // динамик (speaker)
  inputVolume: 1.0, // 0..1.5 (gain)
  outputVolume: 1.0, // 0..1
  soundsEnabled: true, // мастер-выключатель UI-звуков
  // Гранулярные тумблеры — действуют только если soundsEnabled = true.
  soundMessage: true, // звук нового сообщения
  soundIncoming: true, // рингтон входящего звонка
  soundOutgoing: true, // гудки исходящего вызова
  soundConnect: true, // короткий "ап" при соединении
  soundDisconnect: true, // короткий "даун" при завершении
  soundMicMute: true, // пип при мьюте/размьюте микрофона
  soundDeafen: true, // пип при выкл/вкл звука собеседников
  // Глобальная громкость UI-звуков (помимо outputVolume).
  uiVolume: 0.8, // 0..1
  // Индивидуальные громкости сохраняются между звонками.
  // Ключ — userId, значение — проценты 0..100.
  userVolumes: {},
  streamVolumes: {},
  // Настройки исходящей аудио-цепочки (примерно как в OBS).
  // Цепочка: HighPass → Compressor → NoiseGate → MakeupGain. Применяется
  // как в звонке (useCall/useGroupCall), так и в тесте микрофона.
  //
  // Пресет выбирает набор значений ниже одним кликом — «Выкл» / «Стандарт» /
  // «Агрессивный». 'custom' = юзер полез в экспертные настройки и покрутил
  // отдельные ползунки; дропдаун показывает «(Пользовательский)», и при
  // следующем выборе пресета все значения перезапишутся.
  micFilterPreset: 'standard', // 'off' | 'standard' | 'aggressive' | 'custom'
  // Глобальный «рубильник» исходящего pipeline'а. Когда false — в RTC
  // уходит СЫРОЙ track из getUserMedia, без AudioContext-обёртки. Это
  // спасает Electron-десктоп: createMediaStreamDestination там
  // периодически отдаёт «немой» трек (AudioContext успевает уйти в
  // suspended, пока промис getUserMedia резолвится), и пир слышит тишину,
  // хотя локальный тест микро через тот же pipeline работает (там
  // resume() идёт в одном тике user-click). По дефолту ON — большинство
  // юзеров на вебе с этим не сталкиваются; галочку покажем в Audio-табе
  // как «спасательный круг» при тишине у пира.
  audioFiltersEnabled: true,
  // Шумовые ворота выключены по умолчанию: их работу делает нейросеть,
  // а сами они рубят начала фраз и короткие реплики (см. STANDARD_PRESET
  // в utils/audioProcessing.ts). Включаются вручную или пресетом
  // «Агрессивный».
  noiseSuppression: false, // шумовые ворота (gate)
  noiseThreshold: -55, // порог ворот в дБ (-100..0)
  noiseGateHoldMs: 350, // hangover после падения ниже порога, мс
  noiseGateAttackMs: 2, // плавное открытие, мс (анти-щелчок)
  noiseGateReleaseMs: 200, // плавное закрытие, мс
  highPassFilter: true, // вырезать низкочастотный гул (вентилятор и т.п.)
  highPassFrequency: 100, // частота среза HP, Гц (20..400)
  compressorEnabled: true, // компрессор: выравнивает пики и тихие места
  compressorThreshold: -24, // порог срабатывания, дБ (как в OBS)
  compressorRatio: 4, // степень сжатия (1 — без эффекта)
  compressorAttack: 5, // атака, мс
  compressorRelease: 50, // спад, мс
  compressorKnee: 30, // мягкий перегиб, дБ
  makeupGainDb: 0, // добавочное усиление после компрессора, дБ
  // AI-шумодав. Включён по умолчанию — это база современного голосового
  // чата, а не опция для энтузиастов. Ступень грузится лениво при первом
  // запуске пайплайна (WASM + веса вшиты в JS, отдельных файлов раздавать
  // не надо). Если загрузка не удалась — пайплайн сам откатится на RNNoise,
  // а затем на классическую цепочку без AI: звонок состоится в любом случае.
  aiNoiseSuppression: true,
  // Движок: 'fastenhancer' (ICASSP 2026, по умолчанию) или 'rnnoise' (2018).
  // RNNoise легче по CPU, но заметно хуже давит нестационарный шум —
  // чужую речь на фоне, клавиатуру, шаги.
  aiEngine: 'fastenhancer',
  // Размер модели FastEnhancer: 'tiny' | 'base' | 'small'.
  // small — лучшее качество (~36% бюджета кадра), base/tiny — для слабых
  // машин и мобилок.
  aiModelSize: 'small',
  // Клавиатурные биндинги. Применяются ТОЛЬКО в десктоп-версии
  // (Electron'овский globalShortcut). На вебе значения сохраняются
  // в localStorage, но никем не считываются — UI вкладки «Биндинги»
  // тоже спрятан (см. utils/desktop.ts). Формат значений — accelerator-
  // строка Electron'а (https://electronjs.org/docs/latest/api/accelerator)
  // или null, если хоткей не назначен.
  keybinds: {
    toggleMute: null, // мьют микрофона / размьют
    toggleDeafen: null, // выкл / вкл звука собеседников
  },

  // Сетевой режим RTC: принудительно гонять весь медиа-трафик через TURN
  // (iceTransportPolicy: 'relay'). Помогает в двух сценариях:
  //   1) Симметричный NAT/CGNAT/корпоративный firewall — STUN-srflx-пара
  //      «зеленеет» (CONSENT идёт), но реальные RTP-пакеты дропаются на
  //      выходе. ICE считает соединение установленным, watchdog молчит,
  //      а у пира тишина и рамка не загорается.
  //   2) Юзер хочет скрыть свой публичный IP от пира (TURN перебивает
  //      адрес отправителя своим relay-IP).
  // Цена — повышенная задержка и трафик через TURN. Поэтому по дефолту OFF;
  // включается только когда юзер сам ткнёт тогл в настройках.
  forceTurnRelay: false,
};

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULTS, ...parsed };
    // Миграция AI-шумодава.
    //
    // Раньше он был выключен везде, кроме пресета «Агрессивный», и старые
    // конфиги хранят aiNoiseSuppression: false вместе с micFilterPreset:
    // 'standard'. Если просто оставить это как есть, юзер после апдейта
    // не получит шумодав вообще и увидит «Пользовательский» в дропдауне
    // (его сохранённые значения больше не совпадают со «Стандартом»).
    //
    // Поэтому: тем, кто НЕ выбирал «Выкл» осознанно и не крутил ползунки
    // вручную, включаем AI. Пресеты 'off' и 'custom' не трогаем — там
    // выбор юзера явный, и перебивать его нельзя.
    if (parsed && typeof parsed === 'object') {
      const preset = parsed.micFilterPreset;
      if (parsed.aiNoiseSuppression === undefined) {
        // Совсем старый конфиг (поля ещё не было).
        merged.aiNoiseSuppression = preset !== 'off' && preset !== 'custom';
      } else if (
        parsed.aiNoiseSuppression === false &&
        (preset === 'standard' || preset === undefined)
      ) {
        // Конфиг эпохи «AI только в Агрессивном»: false тут — не решение
        // юзера, а прежний дефолт. Поднимаем до нового стандарта.
        merged.aiNoiseSuppression = true;
      }
    }
    // Движок и размер модели появились позже — доливаем дефолты, если их
    // нет в сохранённом конфиге.
    if (!merged.aiEngine) merged.aiEngine = DEFAULTS.aiEngine;
    if (!merged.aiModelSize) merged.aiModelSize = DEFAULTS.aiModelSize;

    // Миграция шумовых ворот.
    //
    // Раньше они были включены в «Стандарте», и у всех в localStorage
    // лежит noiseSuppression: true. Это ровно та настройка, из-за которой
    // съедались начала фраз и короткие реплики: порог по громкости не
    // отличает тихую речь от шума. Теперь эту работу делает нейросеть.
    //
    // Без миграции обновление ничего бы не изменило — сохранённое
    // значение перебивает новый дефолт, и люди продолжили бы жаловаться
    // на пропадающие слова. Как и выше, трогаем только тех, кто не
    // настраивал звук сам: 'off' и 'custom' — осознанный выбор.
    if (parsed && typeof parsed === 'object' && parsed.noiseSuppression === true) {
      const preset = parsed.micFilterPreset;
      if (preset === 'standard' || preset === undefined) {
        merged.noiseSuppression = false;
        merged.noiseGateHoldMs = DEFAULTS.noiseGateHoldMs;
        merged.noiseGateAttackMs = DEFAULTS.noiseGateAttackMs;
        merged.noiseGateReleaseMs = DEFAULTS.noiseGateReleaseMs;
      }
    }
    // Дополняем поле keybinds недостающими ключами — иначе будущие
    // действия (PTT, фокус-окно, ...) не появятся у юзеров со старыми
    // сохранёнными настройками. ...DEFAULTS не делает deep-merge для
    // вложенных объектов — приходится руками.
    merged.keybinds = { ...DEFAULTS.keybinds, ...(parsed?.keybinds || {}) };
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(() => load());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }, [settings]);

  const update = useCallback((patch) => {
    setSettings((s) => ({ ...s, ...patch }));
  }, []);

  const value = useMemo(() => ({ settings, update }), [settings, update]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used inside SettingsProvider');
  return ctx;
}
