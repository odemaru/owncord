import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

// --- Origin -------------------------------------------------------------------
//
// APP_ORIGIN — явный список доменов, которым разрешено обращаться к API
// (через запятую). Если переменная не задана — в dev пускаем всех (совместимость
// со сценарием «vite dev на 5173 → api на 3001»), в production требуем строгий
// список и режем все остальные запросы.
//
// Также используется для socket.io CORS (см. attachSocket).
function parseList(env) {
  if (!env) return null;
  const list = env
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : null;
}

export function getAllowedOrigins() {
  return parseList(process.env.APP_ORIGIN);
}

export function isProd() {
  return (process.env.NODE_ENV || '').toLowerCase() === 'production';
}

export function buildCorsOptions() {
  const allowed = getAllowedOrigins();
  if (!allowed) {
    if (isProd()) {
      // В production без явного списка доменов запрещаем всё (но при этом
      // сервер продолжает раздавать /uploads и SPA с того же origin'а — это
      // не идёт через CORS, потому что same-origin).
      return {
        origin: false,
        credentials: false,
      };
    }
    // dev — разрешаем любые origin'ы, но без credentials, чтобы случайный
    // CSRF-вектор был ослаблен.
    return {
      origin: true,
      credentials: false,
    };
  }
  return {
    origin: (origin, cb) => {
      // origin === undefined — same-origin/Postman/healthchecks: пропускаем.
      if (!origin) return cb(null, true);
      if (allowed.includes(origin)) return cb(null, true);
      return cb(new Error(`origin ${origin} not allowed by CORS`), false);
    },
    credentials: true,
  };
}

export function buildSocketCorsOptions() {
  const allowed = getAllowedOrigins();
  if (!allowed) {
    return isProd() ? { origin: false } : { origin: true };
  }
  return { origin: allowed, credentials: true };
}

// --- Helmet -----------------------------------------------------------------
//
// CSP отключён в dev, чтобы не ломать vite HMR (он использует inline scripts
// и ws://… к dev-серверу). В production включаем строгий CSP, разрешая
// inline-стили (Tailwind инлайнит pre-flight через style тег, а также мы
// используем динамические `style={…}`), но не inline-скрипты.
export function buildHelmet() {
  return helmet({
    contentSecurityPolicy: isProd()
      ? {
          useDefaults: true,
          directives: {
            defaultSrc: ["'self'"],
            // 'wasm-unsafe-eval' — обязателен для WebAssembly.instantiate():
            // на нём работает AI-шумодав (FastEnhancer/RNNoise). Без него
            // Chrome блокирует компиляцию модуля, и шумодав молча
            // деградирует в «без AI» прямо в проде, хотя в dev всё работало
            // (в dev CSP выключён целиком — см. ветку ниже).
            // Важно: это НЕ то же самое, что 'unsafe-eval' — обычный
            // eval() и new Function() остаются запрещены.
            //
            // blob: — FastEnhancer грузит свой AudioWorklet-процессор как
            // inline Blob URL, чтобы не требовать раздачи отдельного .js.
            scriptSrc: ["'self'", "'wasm-unsafe-eval'", 'blob:'],
            // AudioWorklet в Chromium проверяется по worker-src.
            workerSrc: ["'self'", 'blob:'],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'blob:'],
            mediaSrc: ["'self'", 'blob:', 'data:'],
            connectSrc: ["'self'", 'ws:', 'wss:'],
            fontSrc: ["'self'", 'data:'],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
            baseUri: ["'self'"],
            formAction: ["'self'"],
          },
        }
      : false,
    // Отключаем COEP — иначе ломаются <video src="blob:…"> и кросс-оригин
    // ассеты вроде иконок.
    crossOriginEmbedderPolicy: false,
    // Resource policy 'cross-origin' нужен, чтобы /uploads/* можно было
    // читать с другого порта в dev. В prod, когда всё на одном origin'е,
    // это ничего не меняет.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
}

// --- Rate limiting ----------------------------------------------------------
//
// Отдельные лимиты для login/register: 10 попыток на IP за 15 минут.
// `skipSuccessfulRequests: true` — успешные логины не учитываются, чтобы
// нормальный пользователь не упирался в лимит при перезагрузках страницы.
export function authLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'too many attempts, try again later' },
  });
}

// Глобальный rate-limit на API в целом — мягкий, скорее как защита от
// случайного цикла на клиенте, чем от настоящего DoS. Реальный DoS должен
// гасить nginx / cloudflare на уровне выше.
export function apiLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 600, // ~10 rps на IP
    standardHeaders: true,
    legacyHeaders: false,
  });
}

// --- CORS / helmet helper для конкретных корсов ----------------------------
export const cors_ = cors;
