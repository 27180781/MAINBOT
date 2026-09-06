<div dir="rtl">

# פריסה לייצור

שלוש דרכים מקובלות להריץ את MAINBOT. בכולן חייבת להיות כתובת HTTPS ציבורית (למרכזייה ול-OAuth) ו**מופע אחד בלבד** של התהליך (סשני השיחה בזיכרון).

| דרך | מתאים ל- | מסמך |
|---|---|---|
| VPS + PM2 + Caddy | שרת לינוקס קטן משלכם, שליטה מלאה | סעיף 1 |
| Docker compose | אותו VPS, בלי להתקין Node על המארח | סעיף 2 |
| CapRover | פריסה אוטומטית מכל דחיפה ל-GitHub | [CAPROVER.md](CAPROVER.md) |

ב-CapRover שימו לב להוסיף גם את `/app/config` כ-Persistent Directory (בנוסף ל-`/app/data` ו-`/app/.mcp-auth`), אחרת עריכות של `instructions.md` מממשק הניהול יימחקו בפריסה הבאה.

## 1. VPS עם PM2 ו-Caddy

### הכנת השרת

</div>

```bash
# Ubuntu / Debian. Node 22 מ-NodeSource:
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
sudo npm install -g pm2

# משתמש ייעודי בלי הרשאות sudo
sudo adduser --disabled-password --gecos "" mainbot
sudo -iu mainbot
git clone https://github.com/27180781/MAINBOT.git
cd MAINBOT
npm ci
npm run build
cp .env.example .env
nano .env            # ANTHROPIC_API_KEY, WEBHOOK_SECRET, ADMIN_*, PUBLIC_BASE_URL, ALLOWED_CALLER_PHONES ...
nano config/mcp-servers.json
```

<div dir="rtl">

הגדרות חשובות ב-`.env` לייצור:

</div>

```ini
NODE_ENV=production
PORT=3000
HOST=127.0.0.1                 # מאזינים רק מקומית, Caddy מול העולם
PUBLIC_BASE_URL=https://bot.example.com
TRUST_PROXY=true
WEBHOOK_SECRET=<openssl rand -hex 24>
```

<div dir="rtl">

### הפעלה עם PM2

</div>

```bash
pm2 start dist/server.js --name mainbot --time --max-restarts 20
pm2 save
pm2 startup            # מדפיס פקודת sudo אחת להרצה - מפעיל אחרי אתחול
pm2 logs mainbot --lines 100
curl -s http://127.0.0.1:3000/health
```

<div dir="rtl">

אין צורך בדגל `--max-http-header-size`: השרת מגדיר `maxHeaderSize` של 128KB בעצמו (`src/server.ts`).

### Caddy כ-reverse proxy עם HTTPS אוטומטי

</div>

```bash
sudo apt-get install -y caddy      # או לפי https://caddyserver.com/docs/install
sudo nano /etc/caddy/Caddyfile
```

```caddyfile
bot.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:3000 {
        # Claude עם כלים יכול לקחת זמן; המרכזייה מחכה ~30 שניות, ההתחברות ל-MCP יותר
        transport http {
            read_timeout 120s
            write_timeout 120s
        }
    }
    log {
        output file /var/log/caddy/mainbot.log {
            roll_size 20MiB
            roll_keep 5
        }
    }
}
```

```bash
sudo systemctl reload caddy
curl -I https://bot.example.com/health
```

<div dir="rtl">

Caddy מנפיק תעודת Let's Encrypt לבד כשהדומיין מצביע לשרת ופורטים 80/443 פתוחים. ברירת המחדל של Caddy לגודל כותרות (1MB) מספיקה ל-query string הארוך של המרכזייה.

### חלופה: nginx

</div>

```nginx
server {
    listen 443 ssl http2;
    server_name bot.example.com;
    ssl_certificate     /etc/letsencrypt/live/bot.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bot.example.com/privkey.pem;

    # המרכזייה צוברת את כל ההיגדים ב-URL - ברירת המחדל (8k) קטנה מדי
    large_client_header_buffers 4 128k;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        proxy_buffer_size 128k;
        proxy_buffers 4 128k;
    }
}
```

<div dir="rtl">

### חומת אש

</div>

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80,443/tcp
sudo ufw enable
```

<div dir="rtl">

פורט 3000 לא נפתח החוצה. אם משתמשים ב-`npm run mcp:login` מהשרת, ה-callback המקומי (`MCP_OAUTH_CALLBACK_PORT`, ברירת מחדל 8765) נגיש דרך מנהרת SSH (`ssh -L 8765:127.0.0.1:8765 ...`); פשוט יותר להתחבר מ-`/admin`.

## 2. Docker compose

הקבצים `Dockerfile` ו-`docker-compose.yml` נמצאים בשורש המאגר. התמונה נבנית בשני שלבים (בנייה עם devDependencies, הרצה עם dependencies בלבד) על `node:22-alpine`, מריצה `node dist/server.js`, חושפת פורט 3000 ומגדירה `HEALTHCHECK` על `/health`.

</div>

```bash
git clone https://github.com/27180781/MAINBOT.git && cd MAINBOT
cp .env.example .env && nano .env        # PUBLIC_BASE_URL, WEBHOOK_SECRET, ADMIN_*, ANTHROPIC_API_KEY ...
mkdir -p data .mcp-auth
docker compose up -d --build
docker compose ps
docker compose logs -f mainbot
curl -s http://127.0.0.1:3000/health
```

<div dir="rtl">

מה ה-compose עושה:

- `env_file: .env` – כל המשתנים מהקובץ; `PORT`, `HOST`, `DATA_DIR` ו-`MCP_AUTH_DIR` נקבעים בתוך הקונטיינר ואין צורך לשנות אותם ב-`.env`.
- `./data:/app/data` – הגדרות, כללים ויומן השימוש.
- `./.mcp-auth:/app/.mcp-auth` – טוקני OAuth.
- `./config:/app/config` – `mcp-servers.json` ו-`instructions.md`; ממופה **לכתיבה** כי ממשק הניהול שומר את `instructions.md`.
- `ports: "127.0.0.1:3000:3000"` – נחשף רק למארח; Caddy (מסעיף 1) או כל proxy אחר מטפל ב-HTTPS.
- `restart: unless-stopped` ורוטציית לוגים של Docker (‏`max-size` / `max-file`).

הקונטיינר רץ כ-root כדי שיוכל לכתוב לתיקיות הממופות בלי להתעסק בהרשאות. אם רוצים משתמש לא-מיוחס, הוסיפו `user: "1000:1000"` ל-compose ו-`chown -R 1000:1000 data .mcp-auth config` על המארח.

לצד Caddy מותקן על המארח, ה-Caddyfile זהה לסעיף 1. אפשר גם להריץ Caddy כשירות נוסף ב-compose (עם volume ל-`/data` שלו) – אז `reverse_proxy mainbot:3000`.

## 3. סביבה

| נושא | מה לוודא |
|---|---|
| `PUBLIC_BASE_URL` | זהה לכתובת שממנה נכנסים ל-`/admin`, עם `https`, בלי `/` בסוף. אחרת OAuth חוזר לכתובת שגויה. |
| `WEBHOOK_SECRET` | ארוך ואקראי. מופיע ב-URL של המרכזייה – אל תשתפו את הכתובת. |
| `ADMIN_PASSWORD` | ארוך. `/admin` מוגן רק ב-Basic Auth מעל HTTPS. |
| `ALLOWED_CALLER_PHONES` | רק המספרים שצריכים. אל תשאירו `*`. |
| `NODE_ENV=production` | לוגים ב-JSON (נוח ל-`pm2 logs`, `docker logs` ולכלי איסוף). |
| `TIMEZONE` | `Asia/Jerusalem` – משפיע על התאריך בשיחה ועל החיתוך היומי בדוחות. |
| `.env` | הרשאות `600`; לעולם לא ב-git (‏`.gitignore` כבר מכסה). |

טוקנים לשרתי MCP עם `bearer` (למשל `GITHUB_TOKEN`) נכנסים גם הם ל-`.env`. שינוי ב-`.env` או ב-`config/mcp-servers.json` דורש הפעלה מחדש (`pm2 restart mainbot` / `docker compose up -d`); שינוי ב-`/admin` לא.

## 4. גיבויים

מה לגבות (הכול קטן, מגה-בייטים בודדים):

| נתיב | תוכן | רגישות |
|---|---|---|
| `data/settings.json` | הגדרות, רשימת מתקשרים, hash של ה-PIN | בינונית |
| `data/rules.json` | הכללים הקבועים שהוכתבו בטלפון | נמוכה |
| `data/usage/*.jsonl` | יומן שימוש **כולל תמלילי השיחות** | גבוהה |
| `.mcp-auth/*.json` | טוקני OAuth לכל המערכות העסקיות | **גבוהה מאוד** |
| `config/` | שרתי MCP והנחיות העסק | נמוכה |
| `.env` | מפתחות וסיסמאות | **גבוהה מאוד** |

</div>

```bash
# /home/mainbot/backup.sh - גיבוי יומי מוצפן ל-GPG, שומר 30 ימים
#!/usr/bin/env bash
set -euo pipefail
cd /home/mainbot/MAINBOT
STAMP=$(date +%F)
tar czf - data .mcp-auth config .env \
  | gpg --batch --yes --symmetric --cipher-algo AES256 --passphrase-file /home/mainbot/.backup-pass \
  > /home/mainbot/backups/mainbot-$STAMP.tar.gz.gpg
find /home/mainbot/backups -name 'mainbot-*.gpg' -mtime +30 -delete
```

```bash
chmod 700 /home/mainbot/backup.sh
( crontab -l 2>/dev/null; echo "15 3 * * * /home/mainbot/backup.sh" ) | crontab -
# שחזור:
gpg -d --passphrase-file ~/.backup-pass mainbot-2026-09-06.tar.gz.gpg | tar xzf - -C /home/mainbot/MAINBOT
```

<div dir="rtl">

הקבצים נכתבים תוך כדי עבודה (‏`usage` ב-append, `settings`/`rules` בכתיבה אטומית), ולכן גיבוי בזמן ריצה בטוח. העתיקו את הגיבויים לשרת אחר (rclone / scp) – גיבוי על אותו דיסק אינו גיבוי.

## 5. רוטציית לוגים

- **PM2:** `pm2 install pm2-logrotate` ואז `pm2 set pm2-logrotate:max_size 20M` ו-`pm2 set pm2-logrotate:retain 14`.
- **Docker:** ה-compose מגדיר `logging: json-file` עם `max-size: 20m` ו-`max-file: 5`.
- **Caddy:** `roll_size` / `roll_keep` בבלוק ה-`log` (ראו Caddyfile למעלה).
- **יומן השימוש** (`data/usage/`) מתחלק לקובץ חודשי אוטומטית. כל הקבצים נטענים לזיכרון בעלייה, ולכן אחרי שנה-שנתיים כדאי להעביר חודשים ישנים לתיקיית ארכיון (הם ייעלמו מהדשבורד אבל יישארו בגיבוי).

## 6. עדכון גרסה

</div>

```bash
# PM2
cd /home/mainbot/MAINBOT
git pull
npm ci
npm run build
npm run typecheck && npm test     # אופציונלי אבל מומלץ
pm2 restart mainbot --update-env
curl -s http://127.0.0.1:3000/health

# Docker compose
cd MAINBOT
git pull
docker compose build
docker compose up -d
docker compose logs -f --tail 50 mainbot
```

<div dir="rtl">

הערות:

- הפעלה מחדש באמצע שיחה: הבקשה הבאה מהמרכזייה מזוהה מה-`utt_N` והשיחה ממשיכה, אבל ההיסטוריה מול Claude אבדה. עדיף לעדכן כשאין שיחות פעילות – `/health` מחזיר `activeCalls`.
- `data/settings.json` נשמר בין גרסאות; שדה חדש בגרסה חדשה מקבל ברירת מחדל אוטומטית.
- אחרי שדרוג בדקו את לשונית **חיבורים** – אם שרת חזר ל"נדרשת התחברות", התחברו מחדש.

## 7. ניטור

- `GET /health` – ‏`{"ok":true,"servers":[{"name":"crm","state":"connected","tools":112}],"activeCalls":0,"model":"claude-opus-5"}`. שירות uptime (למשל Uptime Kuma / Better Stack) יכול לבדוק שהתשובה מכילה `"ok":true` ושאף שרת חשוב לא במצב `needs_login` / `error`.
- ה-`HEALTHCHECK` של Docker משתמש באותה נקודה; `docker compose ps` מציג `healthy`.
- לוגים חשובים: `PBX request with bad secret`, `caller not in allow-list`, `MCP server unauthorized - login required`, `agent turn failed`, `agent still working - sending filler` (עם `waitedMs`).
- עלויות: לשונית **שימוש וטוקנים** ב-`/admin`, ובמקביל דף ה-Usage בקונסולת Anthropic (המספר המחייב).

</div>
