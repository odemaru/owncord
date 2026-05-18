# Server-side deploy tools

Файлы для разворачивания CI-цепочки и Telegram-уведомлений на сервере.
В рантайме не используются — нужны только при первичной настройке хоста
(или при пересоздании сервера).

| Файл                         | Где живёт                             | Что делает                                                                                                                                |
| ---------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `owncord-deploy.sh`          | `/usr/local/bin/owncord-deploy.sh`    | rsync кода в `/apps/prod/OwnCord`, `npm install:all`, `npm run build`, `systemctl restart owncord`. Вызывается из `.gitlab-ci.yml` через sudo. |
| `owncord-notify.sh`          | `/usr/local/bin/owncord-notify.sh`    | Шлёт сообщение в Telegram (`start`/`stop`/`fail`). Подхватывается systemd-юнитом через `ExecStartPost` / `ExecStopPost`.                  |
| `owncord-notify.env.example` | (template)                            | Образец для `/etc/owncord-notify.env` — там реальные `TG_BOT_TOKEN` и `TG_CHAT_ID` (в репо не коммитятся).                                |
| `owncord.service`            | `/etc/systemd/system/owncord.service` | systemd-юнит для сервиса.                                                                                                                 |
| `sudoers.d-owncord-deploy`   | `/etc/sudoers.d/owncord-deploy`       | NOPASSWD-разрешение для `gitlab-runner` дёргать `owncord-deploy.sh`.                                                                      |
| `install-server-tools.sh`    | (запускается на сервере)              | Раскладывает все файлы по нужным путям.                                                                                                   |

## Первая установка

```bash
# на сервере, из чекаута репо:
cd deploy/server
sudo bash install-server-tools.sh

# затем создаём env с секретами:
sudo cp owncord-notify.env.example /etc/owncord-notify.env
sudo chmod 0640 /etc/owncord-notify.env
sudo nano /etc/owncord-notify.env   # заполнить TG_BOT_TOKEN, TG_CHAT_ID, TG_PROXY

sudo systemctl restart owncord
```

## CI runner

Раннер с тегом `deploy` регистрируется отдельно один раз:

```bash
sudo gitlab-runner register --non-interactive \
  --url https://gitlab.com \
  --token <RUNNER_REGISTRATION_TOKEN> \
  --executor shell \
  --description "owncord-deploy"
```

После этого пуш в `main` запускает job из `.gitlab-ci.yml`.
