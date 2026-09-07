# פריסה ב-CapRover (עם פריסה אוטומטית מכל דחיפה ל-GitHub)

המאגר כולל `captain-definition` שמצביע על ה-`Dockerfile`, כך ש-CapRover בונה את הבוט לבד.
הבוט שומר את השיחות הפעילות בזיכרון, לכן **מריצים מופע (instance) אחד בלבד**.

## 1. יצירת האפליקציה

1. CapRover → Apps → **Create New App**: שם `mainbot`.
   סמנו **Has Persistent Data** (חובה, אחרת הכללים, ההגדרות, השימוש וההתחברויות ל-MCP יימחקו בכל פריסה).
2. בלשונית **App Configs**:
   - **Persistent Directories** (שלושה מיפויים):
     - Path in App: `/app/data` → Label: `mainbot-data`
     - Path in App: `/app/.mcp-auth` → Label: `mainbot-mcp-auth`
     - Path in App: `/app/config` → Label: `mainbot-config` (‏`instructions.md` שממשק הניהול שומר, ו-`mcp-servers.json`; בפריסה הראשונה הנפח מתמלא מהקבצים שבתמונה)

     שימו לב: מרגע ש-`/app/config` נשמר בנפח, שינויים ב-`config/mcp-servers.json` שנדחפים ל-GitHub כבר לא מגיעים לאפליקציה (הנפח מסתיר את העותק שבתמונה). ערכו את הקובץ ישירות בקונטיינר (למשל `docker exec -it $(docker ps -qf name=srv-captain--mainbot) vi /app/config/mcp-servers.json`) והפעילו מחדש את האפליקציה.
   - **Environment Variables** (ראו טבלה למטה).
   - **Instance Count**: `1`.
   - **Container HTTP Port**: `3000`.
3. בלשונית **HTTP Settings**:
   - **Enable HTTPS** ואז **Force HTTPS by redirecting all HTTP traffic to HTTPS**.
   - (אופציונלי) חברו דומיין משלכם, למשל `bot.example.com`.
   - את הכתובת הסופית (למשל `https://mainbot.captain.your-domain.com`) שימו ב-`PUBLIC_BASE_URL`.

## 2. משתני סביבה

| משתנה | חובה | ערך |
|---|---|---|
| `ANTHROPIC_API_KEY` | כן | מפתח מ-console.anthropic.com |
| `WEBHOOK_SECRET` | כן | מחרוזת אקראית ארוכה (למשל `openssl rand -hex 24`). כתובת המרכזייה תהיה `https://<domain>/pbx/technoline/<WEBHOOK_SECRET>` |
| `ADMIN_USER` / `ADMIN_PASSWORD` | כן | פרטי הכניסה לממשק הניהול `/admin` |
| `PUBLIC_BASE_URL` | כן | הכתובת הציבורית של האפליקציה ב-HTTPS, בלי `/` בסוף. נדרש להתחברויות OAuth ל-MCP ולקובצי השמע |
| `ALLOWED_CALLER_PHONES` | כן | המספרים שמורשים להתקשר, מופרדים בפסיק (למשל `0501234567`). אפשר לשנות גם מ-`/admin` |
| `BOT_PIN` | לא | קוד גישה מספרי שיתבקש בתחילת כל שיחה |
| `BOT_MODEL` / `BOT_EFFORT` | לא | ברירת מחדל `claude-opus-5` / `medium`. ניתן לשנות בכל רגע מ-`/admin` |
| `TRUST_PROXY` | לא | `true` (ברירת המחדל) - CapRover עומד מאחורי nginx |
| `NODE_ENV` | לא | `production` (לוגים בפורמט JSON) |
| `TIMEZONE` | לא | `Asia/Jerusalem` (ברירת מחדל) |
| `GITHUB_TOKEN` | לא | רק אם מפעילים את שרת ה-MCP של GitHub ב-`config/mcp-servers.json` |

`PORT` נשאר 3000 (ברירת המחדל של ה-Dockerfile). שאר המשתנים מתועדים ב-`.env.example`.

## 3. פריסה אוטומטית מכל דחיפה ל-GitHub

בלשונית **Deployment** של האפליקציה, **Method 3: Deploy from Github/Bitbucket/Gitlab**:

1. Repository: `github.com/27180781/MAINBOT`
2. Branch: הענף שממנו פורסים (`main` אחרי מיזוג, או `claude/ai-phone-bot-mcp-d9fqra` בינתיים)
3. Username + Password: משתמש GitHub ו-**Personal Access Token** (הרשאת `repo` בלבד), או Deploy Key (SSH) - CapRover מציג את שתי האפשרויות
4. **Save & Update** → CapRover מציג **Webhook URL**
5. ב-GitHub: Settings → Webhooks → Add webhook → Payload URL = ה-Webhook URL, Content type `application/json`, אירוע `Just the push event`

מעכשיו כל דחיפה לענף בונה את התמונה מחדש ומפעילה אותה. הנתונים ב-`/app/data`, ב-`/app/.mcp-auth` וב-`/app/config` נשמרים בין פריסות.

## 4. אחרי הפריסה הראשונה

1. גלשו ל-`https://<domain>/admin` והתחברו (Basic Auth).
2. בלשונית **חיבורים** לחצו **התחבר** ליד כל שרת MCP (OAuth) ואשרו בדפדפן. אחרי ההתחברות מספר הכלים של השרת יופיע.
3. העתיקו את כתובת ה-Webhook מהלשונית והגדירו אותה כשלוחת API בטכנוליין (GET). נתבו מספר או מקש בתפריט לשלוחה.
4. בדקו בלשונית **בדיקה** (צ'אט טקסט) שהבוט עונה ומשתמש בכלים, ואז התקשרו.
5. `https://<domain>/health` מחזיר JSON עם מצב החיבורים - נוח לניטור.

## 5. תקלות נפוצות

- **הבנייה נכשלת** - ודאו שה-`Dockerfile` וה-`captain-definition` קיימים בענף שנבחר, ושה-Node בתמונה הוא 22.
- **"נדרשת התחברות" אחרי פריסה** - כנראה ש-`/app/.mcp-auth` לא הוגדר כ-Persistent Directory.
- **ההוראות שנערכו ב-`/admin` נעלמו אחרי פריסה** - `/app/config` לא הוגדר כ-Persistent Directory.
- **ההתחברות ל-MCP חוזרת לכתובת שגויה** - `PUBLIC_BASE_URL` חייב להיות זהה לכתובת שממנה נכנסים ל-`/admin` (כולל https).
- **המרכזייה מקבלת 403** - ה-`WEBHOOK_SECRET` בכתובת שהוגדרה בטכנוליין שונה מזה שבמשתני הסביבה.
