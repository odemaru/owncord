# Постоянный сервер внутри ZeroTier

Сценарий: отдельная машина, которая работает круглосуточно, доступна
только по ZeroTier, наружу в интернет не смотрит. Все заходят через
браузер, нужны шумодав и демонстрация экрана.

Это не то же самое, что деплой из [`DEPLOY.md`](./DEPLOY.md) — там домен,
nginx и Let's Encrypt. Здесь ничего этого нет и не нужно.

---

## Что понадобится

- Машина под сервер: VPS, мини-ПК, старый ноутбук — что угодно с Linux,
  что не выключается. Для группы до 10 человек хватает 1 CPU / 1 ГБ RAM:
  сервер только раздаёт статику и гоняет сигналинг, медиа идёт мимо него.
- Аккаунт ZeroTier с уже созданной сетью.
- Твой Mac — на нём лежит корневой центр сертификации, выпущенный
  mkcert'ом. **Он остаётся здесь и никуда не копируется.**

---

## 1. Подключить сервер к ZeroTier

На сервере:

```bash
curl -s https://install.zerotier.com | sudo bash
```

```bash
sudo zerotier-cli join a581878f7da9823c
```

Дальше зайти на my.zerotier.com → сеть `a581878f7da9823c` → раздел
Members → у нового узла поставить галочку **Auth**. Сеть приватная, без
этого он не подключится.

Там же, в строке узла, задай ему **фиксированный IP** — например
`10.150.20.10`. Это важно: адрес попадёт в сертификат, и если ZeroTier
однажды выдаст другой, HTTPS сломается у всех разом. В интерфейсе это
поле «Managed IPs» — впиши адрес вручную и убери автоматически
назначенный.

Проверить:

```bash
sudo zerotier-cli listnetworks
```

Статус должен быть `OK`, в конце строки — назначенный адрес.

---

## 2. Выпустить сертификат (на Mac, не на сервере)

Ключ центра сертификации не должен уезжать с твоей машины. Поэтому
сертификат для сервера выпускается здесь, а на сервер уезжает только он
сам и его ключ.

```bash
cd ~/Documents/GitHub/OwnCord/server/certs && mkcert 10.150.20.10
```

Подставь тот адрес, который закрепил за сервером на шаге 1.

Скопировать на сервер:

```bash
scp 10.150.20.10.pem 10.150.20.10-key.pem user@10.150.20.10:/tmp/
```

Когда сертификат подойдёт к концу срока (mkcert выдаёт примерно на три
года), повторить этот шаг — на сервере ничего перенастраивать не надо.

---

## 3. Развернуть приложение

На сервере:

```bash
sudo apt update && sudo apt install -y git curl
```

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs
```

```bash
sudo git clone https://github.com/odemaru/owncord.git /opt/owncord
```

Репозиторий приватный — git спросит логин и токен GitHub. Проще заранее
завести SSH-ключ или personal access token.

```bash
cd /opt/owncord && sudo npm run install:all && sudo npm run build
```

Положить сертификаты на место:

```bash
sudo mkdir -p /opt/owncord/server/certs && sudo mv /tmp/10.150.20.10*.pem /opt/owncord/server/certs/
```

---

## 4. Конфиг

Создать `/opt/owncord/server/.env`:

```bash
sudo nano /opt/owncord/server/.env
```

```ini
NODE_ENV=production
PORT=3001

# Слушать только ZeroTier-интерфейс. Без этого сервер торчал бы и в ту
# сеть, где физически стоит машина — соседям по хостингу или домашнему
# Wi-Fi он не нужен.
HOST=10.150.20.10

# Сгенерировать: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
JWT_SECRET=подставь_сюда_свою_строку

# TLS. Без этого браузер не даст ни микрофон, ни демонстрацию экрана.
TLS_CERT_FILE=./certs/10.150.20.10.pem
TLS_KEY_FILE=./certs/10.150.20.10-key.pem

# Фронт и API на одном origin, CORS не нужен.
APP_ORIGIN=https://10.150.20.10:3001

# Код регистрации. Без него зарегистрироваться сможет любой, кто попал в
# сеть. Раздай его своим, а когда все зайдут — поставь REGISTRATION_DISABLED=1.
REGISTRATION_CODE=придумай_код

# Сколько дней хранить историю и вложения. По умолчанию 90.
RETENTION_DAYS=365

# Потолок размера файла в мегабайтах.
MAX_UPLOAD_MB=500
```

Закрыть файл от чужих глаз:

```bash
sudo chmod 600 /opt/owncord/server/.env /opt/owncord/server/certs/*-key.pem
```

`NODE_ENV=production` тут обязателен: он включает строгий CSP и
запрещает серверу стартовать со слабым секретом. CSP в этой сборке уже
пропускает WASM-шумодав — если будешь править его руками, не потеряй
`'wasm-unsafe-eval'` и `blob:` в `script-src`, иначе шумоподавление молча
отключится.

---

## 5. Автозапуск

```bash
sudo useradd -r -s /bin/false owncord && sudo chown -R owncord:owncord /opt/owncord
```

```bash
sudo nano /etc/systemd/system/owncord.service
```

```ini
[Unit]
Description=OwnCord
After=network-online.target zerotier-one.service
Wants=network-online.target

[Service]
Type=simple
User=owncord
WorkingDirectory=/opt/owncord/server
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

`After=zerotier-one.service` важен: сервер прибит к ZeroTier-адресу и без
поднятого интерфейса просто не сможет забиндиться.

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now owncord && sudo systemctl status owncord
```

Логи: `sudo journalctl -u owncord -f`

---

## 6. Firewall

Открыть порт только внутри ZeroTier, наружу — ничего:

```bash
sudo ufw allow in on ztyourinterface to any port 3001 proto tcp
```

Имя интерфейса смотрится через `ip -br link | grep zt`. На Linux
ZeroTier обычно создаёт `ztXXXXXXXX`.

---

## 7. Установить сертификат участникам

Каждому устройству нужно доверять твоему CA — иначе браузер покажет
предупреждение, а микрофон и демонстрация экрана не заработают даже
после «Всё равно перейти».

Раздать надо файл **`rootCA.pem`** (для Windows — переименованный в
`rootCA.crt`), он лежит на Mac в `~/Library/Application Support/mkcert`.
Пошаговая установка для macOS, Windows, Android, iOS и Firefox —
в [`LAN-HTTPS.md`](./LAN-HTTPS.md).

Файл `rootCA-key.pem` не отдавать никому и никогда — с ним можно выписать
доверенный сертификат на любой сайт для всех, у кого установлен твой CA.

Это делается один раз на устройство. Дальше можно менять серверы и
переиздавать сертификаты — заново ставить CA не понадобится.

---

## Открыть

`https://10.150.20.10:3001` — замок обычный, без предупреждений.

---

## Про звонки и демонстрацию экрана

Внутри ZeroTier всё соединяется напрямую: у каждого устройства адрес в
одной подсети `10.150.20.0/24`, WebRTC находит эти адреса среди
кандидатов и связывается peer-to-peer. Медиа через сервер не идёт, он
только сводит участников.

**TURN не нужен.** В [`turn/`](./turn) лежит готовый coturn, но он
решает проблему строгого NAT в публичном интернете. У тебя этой проблемы
нет — ZeroTier сам является тем слоем, который её обходит.

**Демонстрация экрана** работает на всех десктопах и на Android Chrome.
На iPhone и iPad её нет — Safari не поддерживает `getDisplayMedia`; с
телефона можно смотреть чужую демонстрацию и участвовать в звонке, но не
делиться своим экраном. Это ограничение Apple, обойти нельзя.

**Групповые звонки** идут по mesh: каждый держит соединение с каждым.
Практический потолок — 8–10 человек, дальше упирается в исходящий канал
участников. Для больших встреч нужен SFU, это отдельная большая работа.

**Демонстрация в 1440p** ест до 12 Мбит/с на каждого зрителя. Внутри
ZeroTier трафик идёт напрямую между участниками, но упирается в их
реальные каналы. Если картинка сыпется — снизь качество в настройках
демонстрации до 720p.

---

## Резервные копии

Всё состояние — в двух местах:

```bash
sudo tar czf owncord-backup-$(date +%F).tar.gz -C /opt/owncord/server data uploads
```

`data/` — база SQLite и ключи Web Push, `uploads/` — аватары, голосовые и
файлы. Конфиг `.env` забэкапить отдельно, в архив он не попадает.

---

## Обновление

```bash
cd /opt/owncord && sudo -u owncord git pull && sudo -u owncord npm run install:all && sudo -u owncord npm run build && sudo systemctl restart owncord
```

Подтянуть изменения из репозитория автора:

```bash
git fetch upstream && git merge upstream/main
```

---

## Если что-то не работает

**Страница не открывается.** Проверь с клиента `ping 10.150.20.10`. Не
идёт — устройство не авторизовано в сети, поставь Auth в ZeroTier
Central. Идёт, но страница не грузится — смотри `sudo systemctl status
owncord` и firewall.

**Замок перечёркнут.** CA установлен не до конца. На iOS почти всегда
забывают второй шаг: Настройки → Основные → Об этом устройстве →
Доверие сертификатам.

**Нет доступа к микрофону.** Открой консоль браузера и проверь
`isSecureContext` — должно быть `true`. `false` означает, что сертификат
не доверен.

**Шумодав не включается.** В консоли будет ошибка CSP про WebAssembly.
Значит `script-src` потерял `'wasm-unsafe-eval'`. Если поставил перед
приложением nginx — он шлёт свой заголовок CSP, и браузер применяет
пересечение политик: править надо оба места.

**Звонок не соединяется.** Редкий случай, но если у кого-то Chrome
прячет локальные адреса: `chrome://flags/#enable-webrtc-hide-local-ips-with-mdns`
→ Disabled. Обычно не требуется — после выдачи разрешения на микрофон
Chrome и так показывает реальные адреса интерфейсов.
