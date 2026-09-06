# MAINBOT Realtime – עוזר קולי בזמן אמת (LiveKit Agents)

שיחה קולית זורמת עם אותו עוזר: מדברים, הוא עונה תוך כדי, אפשר לקטוע אותו באמצע משפט, בלי תפריטי מקשים. זה תוסף לפרויקט – הבוט הטלפוני של טכנוליין (`/pbx/technoline`) וה-Chat API של ה-CRM ממשיכים לעבוד כרגיל.

**סוכן אחד, שני שלבים**: קוד הסוכן זהה; מה שמשתנה הוא רק איך האודיו מגיע – בשלב א' מהדפדפן (WebRTC), בשלב ב' מקו ימות המשיח (SIP).

## ארכיטקטורה

```
מיקרופון (דפדפן / טלפון SIP)
   │  WebRTC / SIP → LiveKit (Cloud או self-host)
   ▼
LiveKit Agents worker (realtime/agent.py, Python 3.12)
   ├─ Soniox STT (עברית+אנגלית, סטרימינג, זיהוי סוף תור)
   ├─ Claude (claude-sonnet-5, streaming, tools)  ← אותם שרתי MCP של הבוט
   ├─ ElevenLabs Flash / Soniox TTS (סטרימינג – מתחיל לדבר לפני סוף המשפט)
   └─ Silero VAD + barge-in
   │
   └─ GET https://mainbot…/internal/agent-config  ← הבוט ב-Node משתף: טוקני OAuth של שרתי ה-MCP,
                                                     הכללים הקבועים, הנחיות העסק, רשימת המורשים
```

מה נשמר על השרת: `data/realtime/<תאריך>/<חדר>.jsonl` – לוג latency לכל שלב (STT / LLM / TTS) ותמליל מלא של כל שיחה.

### מה מקבלים מהבריף

| דרישה | איפה זה קורה |
|---|---|
| משפט מילוי ברגע שקריאת כלי מתחילה | הפרומפט מחייב משפט לפני כל כלי, ו-`MainbotAgent.llm_node` מוסיף "רגע, בודק." אם Claude התחיל ישר בקריאת כלי |
| תשובות קצרות, בלי רשימות | הפרומפט ב-`mainbot_rt/prompt.py` + `tts_text_transforms` של LiveKit (מסנן markdown ואימוג'י) |
| תקציב latency ומדידה לכל שלב | `mainbot_rt/latency.py` – רשומת `turn_latency` לכל תור: `eou_delay + llm_ttft + tts_ttfb` |
| קריאה חופשית, כתיבה באישור | `mainbot_rt/policy.py` + `gated_mcp.py` – אותה מדיניות בדיוק כמו בבוט הטלפוני, כולל השוואת פרמטרים |
| לא לבנות מחדש את שכבת הכלים | הסוכן מתחבר ישירות לאותם endpoints של MCP; הבוט ב-Node רק משתף איתו את הטוקנים |
| barge-in | `turn_handling.interruption` + Silero VAD |

## שלב א' – דפדפן

### דרישות

- פרויקט LiveKit (מומלץ LiveKit Cloud – ראו "Cloud מול self-host" למטה): `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
- מפתח Anthropic, מפתח Soniox, מפתח ElevenLabs + `voice_id` של קול רב-לשוני (או Soniox TTS)
- הבוט ב-Node רץ עם `INTERNAL_API_KEY` מוגדר (בלי זה הסוכן עובד אבל בלי כלים ובלי כללים)
- Python 3.12 (או Docker)

### הרצה מקומית

```bash
cd realtime
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # למלא מפתחות
python agent.py download-files  # מוריד את מודל ה-VAD פעם אחת
python agent.py dev             # ה-worker מתחבר ל-LiveKit ומחכה לחדרים
# בטרמינל שני:
python token_server.py          # דף הבדיקה: http://localhost:8080  (מפתח: WEB_ACCESS_KEY)
```

בדף לוחצים "התחבר ודבר", מדברים בעברית, קוטעים באמצע – ועוקבים אחרי הזמן שמופיע למטה. הלוג המלא ב-`data/realtime/`.

`python agent.py console` פותח מצב בדיקה בטרמינל בלי LiveKit בכלל (מיקרופון ורמקול מקומיים) – נוח לדבג את צנרת הקול.

### הגדרת ההתנהגות

הכול ב-`.env.example`. הנקודות החשובות:

- `RT_MODEL` / `RT_EFFORT` – `claude-sonnet-5` ב-`low` הוא נקודת ההתחלה (מהיר). `claude-haiku-4-5` מהיר וזול יותר אבל פחות חכם בקריאות כלים מורכבות; `claude-opus-5` איטי יותר. החשיבה (thinking) כבויה במכוון – ה-plugin של LiveKit לא מעביר בלוקי חשיבה בין תורות, וזה גם חוסך זמן.
- `RT_TURN_DETECTION=stt` – סוף תור לפי זיהוי נקודות הסיום של Soniox (עובד בעברית). `vad` הוא הגיבוי. מודל ה-turn detector של LiveKit לא נבדק על עברית ולכן לא בשימוש.
- `RT_MIN_ENDPOINTING_DELAY` – כמה זמן שקט לפני שהסוכן עונה. 0.4 שניות זו התחלה; להוריד אם התגובה איטית, להעלות אם הוא קוטע אתכם באמצע משפט.
- `STT_CONTEXT` – מילים שהתמלול צריך לצפות (שמות מוצרים, מונחים). משפר דיוק בעברית.
- `RT_NOISE_CANCELLATION=auto` – ביטול רעשים של LiveKit Cloud (BVC, וגרסת טלפוניה ל-SIP). ב-self-host יש להגדיר `off`.

### מה מוגדר סיום (Definition of Done)

- דף בדפדפן, שיחה פתוחה בעברית, ניתן לקטוע באמצע ✔ (`web/index.html`)
- שלוש קריאות כלי אמיתיות – למשל: "מה יש בתיבת הפניות?", "האם 7 באוקטובר פנוי?", "כמה חובות פתוחים בסאמיט?" – בודקים ב-`data/realtime/…jsonl` שרשומות `tool` הופיעו עם `decision: allowed`
- לוג latency לכל שלב + תמליל ✔

## שלב ב' – טלפון (SIP)

מתחילים רק אחרי ששלב א' יציב.

### מסלול ראשי: `routing_ip` בימות → LiveKit SIP

1. ב-LiveKit: יוצרים **Inbound Trunk** עם `allowed_addresses` מוגבל לכתובות שמהן ימות שולחת INVITE (לברר מול התמיכה של ימות), ו-**Dispatch Rule** שמכניס כל שיחה לחדר חדש (`individual`). דוגמה ב-CLI של LiveKit:

   ```bash
   lk sip inbound create --config - <<'JSON'
   { "name": "yemot", "numbers": ["<המספר של הקו בימות>"], "allowed_addresses": ["<IP של ימות>/32"], "krisp_enabled": true }
   JSON
   lk sip dispatch create --config - <<'JSON'
   { "name": "mainbot", "rule": { "dispatchRuleIndividual": { "roomPrefix": "call-" } } }
   JSON
   ```

   (הסוכן רשום בלי `agent_name`, ולכן הוא מצטרף אוטומטית לכל חדר חדש.)

2. בימות: שלוחה מסוג **`routing_ip`** ("ניתוב שיחה למחשב חיצוני"). שדות החובה לפי הסכמה: `routing_ip` (כתובת ה-SIP של ה-trunk ב-LiveKit, למשל `<project>.sip.livekit.cloud`) ו-`routing_extension` (מספר השלוחה/היעד שיישלח ב-INVITE). כתובת ה-SIP המדויקת מופיעה בפרויקט LiveKit תחת SIP.
3. הסוכן מזהה משתתף SIP לפי `sip.phoneNumber`, בודק אותו מול רשימת המורשים (מהבוט ב-Node או `ALLOWED_CALLER_PHONES`), ומנתק מספר לא מורשה אחרי משפט אחד. אין PIN.

### מסלול גיבוי: Asterisk / FreeSWITCH קטן על CapRover

אם `routing_ip` סגור בחשבון: מרימים Asterisk שנרשם כחשבון SIP (שלוחת `sip` בימות, "חשבון SIP") מול `sip.yemot.co.il`, ומגשר את השיחה ב-INVITE ל-LiveKit. שימו לב: LiveKit לא מקבל REGISTER (מחזיר 405), ולכן אי אפשר לרשום אותו ישירות לימות – זו בדיוק הסיבה לגשר. ב-CapRover צריך לפתוח UDP 5060 וטווח RTP (למשל 10000–10100) על המכונה עצמה; זה לא עובר דרך ה-nginx של CapRover.

### מה משתנה בטלפון

- **8kHz**: דיוק התמלול בעברית יורד. בודקים על הקו האמיתי, מוסיפים `STT_CONTEXT`, ואם צריך מעלים `RT_MIN_ENDPOINTING_DELAY`.
- **ביטול רעשים**: הסוכן בוחר אוטומטית `BVCTelephony` למשתתף SIP.
- **קטיעות**: בטלפון יש יותר רעש רקע – אם הסוכן נקטע לשווא, להעלות `RT_MIN_INTERRUPTION_DURATION` ל-0.8 או להגדיר `RT_MIN_INTERRUPTION_WORDS=2`.

## לברר לפני שמתחילים (מהבריף)

1. **ימות המשיח**: האם `routing_ip` פתוח בחשבון, ומהו טווח ה-IP שממנו נשלח ה-INVITE. אם הוא סגור – מסלול הגיבוי.
2. **LiveKit Cloud מול self-host על CapRover**:
   - Cloud: SIP מובנה, ביטול רעשים, ללא תחזוקה, אזור קרוב (EU) נותן מישראל בדרך כלל 40–80 ms. מומלץ לשני השלבים.
   - Self-host: צריך את השרת + `sip` service נפרד, UDP פתוח לרשת, TURN, ואין BVC. חוסך את עלות Cloud אבל מוסיף תחזוקה ותקלות רשת – לא כדאי לפני שהמוצר עובד.
3. **עלות לדקת שיחה** (הערכה גסה, לאמת מול המחירונים העדכניים):
   - Soniox STT realtime: כמה סנטים לדקה
   - Claude Sonnet 5: תור ממוצע ~3–6K טוקני קלט (רובם מקאש) + ~100 טוקני פלט → בסביבות 0.5–1.5 סנט לתור, כלומר ~5–10 סנט לדקת שיחה עם כלים
   - ElevenLabs Flash: לפי תווים, בערך 2–8 סנט לדקת דיבור בהתאם לתוכנית
   - LiveKit Cloud: דקות סוכן + דקות SIP (סנטים בודדים לדקה)
   - סך הכול: בסדר גודל של 10–25 סנט לדקת שיחה. ה-`usage` שנרשם בסוף כל סשן בלוג מאפשר לחשב במדויק.

## פריסה ב-CapRover

אפליקציה נפרדת (למשל `mainbot-realtime`), עם ה-`captain-definition` שבתיקייה הזו:

- Deployment מ-GitHub עם **Dockerfile path** `realtime/Dockerfile`? CapRover בונה את השורש של המאגר; לכן מגדירים ב-App Configs → "Deploy from Github" את הענף, ובלשונית Deployment את `captain-definition` הראשי. הדרך הפשוטה: ליצור ב-CapRover אפליקציה שנייה ולהעלות אותה עם `caprover deploy -a mainbot-realtime` מתוך `realtime/` (ה-CLI שולח את התיקייה הנוכחית), או להגדיר Persistent Directory ומשתני סביבה ידנית.
- Container HTTP Port: `8080` (דף הבדיקה + טוקנים). ה-worker עצמו לא צריך פורט פתוח – הוא פותח חיבור יוצא ל-LiveKit.
- Persistent Directory: `/app/data` (הלוגים והתמלילים).
- משתני סביבה: כמו `.env.example`; `MAINBOT_URL` = כתובת הבוט ב-Node, `INTERNAL_API_KEY` = אותו ערך שהוגדר שם.
- Instance Count: 1 (ה-worker מטפל בכמה שיחות במקביל בתהליכי משנה).

## קבצים

| קובץ | תפקיד |
|---|---|
| `agent.py` | ה-worker: STT/LLM/TTS, turn handling, כלים מקומיים (`end_call`, `add_rule`), whitelist ל-SIP |
| `mainbot_rt/gated_mcp.py` | שרתי MCP עם שער האישורים סביב כל קריאה |
| `mainbot_rt/policy.py` | סיווג קריאה/כתיבה + ConfirmationGate (העתק של `src/mcp/tool-policy.ts`) |
| `mainbot_rt/node_bridge.py` | קריאה ל-`/internal/agent-config` ו-`/internal/rules` של הבוט ב-Node |
| `mainbot_rt/prompt.py` | הפרומפט העברי לערוץ קול בזמן אמת |
| `mainbot_rt/latency.py` | לוג latency ותמליל ל-JSONL |
| `token_server.py`, `web/index.html` | דף הבדיקה בדפדפן ושרת הטוקנים |
