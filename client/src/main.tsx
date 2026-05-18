import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import { SettingsProvider } from './context/SettingsContext';
import { MutesProvider } from './context/MutesContext';
import { ConfigProvider } from './context/ConfigContext';
import { GroupsProvider } from './context/GroupsContext';
import UpdateToast from './components/UpdateToast';
import TitleBar from './components/TitleBar';
import { attachNotificationClickHandler } from './utils/push';
import { isDesktop } from './utils/desktop';
import '@fontsource-variable/inter';
import './index.css';

// Маркируем body для CSS, который оставляет 32px паддинга под кастомный
// титлбар (см. index.css → body.is-desktop). Делаем это синхронно ДО
// первого рендера, чтобы не было «прыжка» layout'а в момент гидрации.
if (typeof document !== 'undefined' && isDesktop()) {
  document.body.classList.add('is-desktop');
}

// Слушать клики по push-уведомлениям и эмитить кастомное событие, на
// которое подписан Home.jsx (для открытия нужного чата).
attachNotificationClickHandler();

// Регистрируем service worker сразу при загрузке (не лениво) — это нужно,
// чтобы Chrome/Edge показывали «Install app» баннер и работал A2HS на iOS.
// Существующая ленивая регистрация в utils/push.ts остаётся как fallback —
// register() идемпотентен, вернёт ту же registration.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch(() => {
        /* silently ignore — на http (dev без proxy) SW недоступен */
      });
  });
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <ConfigProvider>
          <SettingsProvider>
            <AuthProvider>
              <MutesProvider>
                <GroupsProvider>
                  {/* TitleBar рендерится только в Electron (внутри сам делает
                      isDesktop-чек). Кладём поверх всего, position:fixed
                      внутри. На вебе — null, никаких лишних DOM-узлов. */}
                  <TitleBar />
                  <App />
                  <UpdateToast />
                </GroupsProvider>
              </MutesProvider>
            </AuthProvider>
          </SettingsProvider>
        </ConfigProvider>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
