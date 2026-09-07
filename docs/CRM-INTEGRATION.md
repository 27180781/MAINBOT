# שימוש בעוזר בתוך ה-CRM (ומערכות אחרות) דרך ה-Chat API

אותו מנוע שעונה בטלפון זמין גם כצ'אט טקסט: אותם כלי MCP, אותם כללים קבועים, אותו מנגנון אישור לפני פעולות. ההבדל היחיד הוא הפרומפט: בצ'אט מותר עיצוב קל (רשימות, הדגשות), והמודל מונחה לא להשתמש ב-`end_call` (אם בכל זאת יקרא לו, התשובה חוזרת עם `endCall: true` ואפשר להתעלם). שני משתמשים שכותבים באותו `sessionId` מקבלים מענה בזה אחר זה, לא במקביל; `sessionId` לא תקין מוחלף במזהה חדש שחוזר בתשובה.

## נקודת הקצה

```
POST https://mainbot.caprover.clicker.co.il/api/v1/chat
Authorization: Bearer <CHAT_API_KEY>
Content-Type: application/json
```

גוף הבקשה:

| שדה | חובה | תיאור |
|---|---|---|
| `message` | כן | הודעת המשתמש (עד 20,000 תווים) |
| `sessionId` | לא | מזהה שיחה (עד 128 תווים: אותיות, ספרות, `_ . : @ -`). שולחים את אותו מזהה בכל הודעה כדי לשמור הקשר. אם לא נשלח, השרת מייצר אחד ומחזיר אותו |
| `userId` | לא | מזהה המשתמש ב-CRM (לרישום השימוש ולזיהוי בפרומפט) |
| `userName` | לא | שם תצוגה של המשתמש ("נסים") |
| `reset` | לא | `true` מתחיל שיחה חדשה באותו `sessionId` |
| `history` | לא | עד 40 הודעות קודמות `{ role: "user" \| "assistant", content }` מהשרשור שה-CRM שומר. הבוט משתמש בהן רק כשאין לו שיחה חיה ל-`sessionId` הזה (אחרי הפעלה מחדש או אחרי שעתיים ללא פעילות), כדי להמשיך מאותו הקשר |

תשובה:

```json
{
  "sessionId": "crm:user-42:conv-7",
  "text": "יש 3 פניות שלא נענו: ...",
  "toolCalls": ["crm__list_unanswered"],
  "iterations": 2,
  "durationMs": 4180,
  "newSession": false
}
```

`newSession` הוא `true` כשהבוט פתח שיחה חדשה ל-`sessionId` (ואז `history`, אם נשלח, נטען לתוכה).

`text` הוא הטקסט להצגה (עברית, ייתכן markdown קל). `toolCalls` הם הכלים שהופעלו (שימושי להצגת "בודק ב-CRM..."). כשמשהו נכשל מופיע גם `error` (טקסט טכני), אבל `text` תמיד מכיל משפט ידידותי להצגה.

מחיקת שיחה: `DELETE /api/v1/chat/:sessionId` (עם אותו Bearer). בדיקת חיות: `GET /api/v1/health` (ללא אימות).

השיחות נשמרות בזיכרון השרת עד שעתיים מהפעילות האחרונה (`CHAT_SESSION_TTL_MS`).

## אישור פעולות

כמו בטלפון: פעולה שמשנה נתונים או שולחת הודעה נחסמת בפעם הראשונה, העוזר מתאר מה הוא עומד לעשות ומבקש אישור, וההודעה הבאה של המשתמש ("כן") משחררת אותה. אין צורך בטיפול מיוחד בצד ה-CRM - זה קורה בתוך השיחה.

## הגדרה בצד הבוט

לא צריך להמציא מפתח: אם `CHAT_API_KEY` לא מוגדר, השרת מייצר מפתח אקראי בעצמו (נשמר ב-`data/secrets.json`) ומציג אותו ב-`/admin` → "חיבורים" → "חיבור ל-CRM ולמערכות אחרות", עם כפתורי הצג / העתק / החלף מפתח. אם מעדיפים לקבוע אותו ידנית, ב-CapRover (או ב-`.env`):

```
CHAT_API_KEY=<מחרוזת אקראית של 32 תווים לפחות, למשל openssl rand -hex 24>
```

אם ה-CRM קורא ל-API **מהדפדפן** (לא מומלץ - המפתח ייחשף), הוסיפו גם:

```
CHAT_CORS_ORIGINS=https://crm.example.com
```

הדרך המומלצת: הפרונט של ה-CRM קורא ל-Edge Function שלו, וה-Edge Function קורא לבוט עם המפתח (המפתח נשאר בשרת).

## החיבור שבוצע ב-CRM של חוויה בקליק

ב-CRM (פרויקט Lovable `click-connect-crm`) ה-Edge Function `assistant-chat` – זו שמאחורי דף "עוזר AI ניהולי" – מנתבת ל-MAINBOT כשקיימים שני הסודות `MAINBOT_URL` ו-`MAINBOT_CHAT_API_KEY`, ואחרת ממשיכה עם המנוע המובנה. היא שולחת `sessionId = crm:<user_id>:<thread_id>`, את שם המשתמש, ואת ההודעות הקודמות של השרשור כ-`history`; התשובה נשמרת בטבלת ההודעות של ה-CRM כרגיל, והכלים שהופעלו מופיעים כבועת "כלי" מתקפלת. בדף עצמו מופיע תג "MAINBOT" כשהתשובה הגיעה מהבוט. את המפתח מכניסים ב-Lovable (ניהול סודות של הפרויקט) בשם `MAINBOT_CHAT_API_KEY`, אחרי שמעתיקים אותו מ-`/admin`.

## דוגמה: Supabase Edge Function (Deno)

```ts
// supabase/functions/assistant-chat/index.ts
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const BOT_URL = Deno.env.get("MAINBOT_URL")!;          // https://mainbot.caprover.clicker.co.il
const BOT_KEY = Deno.env.get("MAINBOT_CHAT_API_KEY")!; // אותו ערך כמו CHAT_API_KEY בבוט

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const { message, sessionId, userId, userName, reset } = await req.json();

  const res = await fetch(`${BOT_URL}/api/v1/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${BOT_KEY}` },
    body: JSON.stringify({ message, sessionId, userId, userName, reset }),
  });

  return new Response(await res.text(), {
    status: res.status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
});
```

הגדרת הסודות: `supabase secrets set MAINBOT_URL=... MAINBOT_CHAT_API_KEY=...`

בצד הפרונט, חלון הצ'אט הקיים ב-CRM שולח `{ message, sessionId, userId, userName }` ל-Edge Function ומציג את `text` שחוזר. את `sessionId` כדאי לגזור מהמשתמש והשיחה (למשל `crm:<userId>:<conversationId>`), וכפתור "שיחה חדשה" שולח `reset: true`.

## דוגמה מהירה ב-curl

```bash
curl -s https://mainbot.caprover.clicker.co.il/api/v1/chat \
  -H "Authorization: Bearer $CHAT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"message":"מה יש בתיבת הפניות שלא ענו עליו?","sessionId":"test-1","userName":"נסים"}'
```

## אירועים מה-CRM אל העוזר (משימות יזומות)

אותו מפתח משמש גם את `POST /api/v1/events`: ה-CRM שולח `{ "type": "new_lead", "payload": {...} }` וכל משימה יזומה שמאזינה לסוג האירוע רצה ברקע (בקריאה בלבד) ומודיעה לבעל העסק אם יש מה לדווח. נוח לחבר לכלל אוטומציה או ל-webhook endpoint קיים ב-CRM. פירוט ודוגמאות: [ROUTINES.md](ROUTINES.md).

## הערות

- הזמן לתשובה תלוי בכלים: שאלה פשוטה 2–5 שניות, בקשה עם כמה קריאות ל-CRM 10–30 שניות. הציגו אינדיקציית "חושב" ואל תגדירו timeout קצר מ-60 שניות.
- השימוש והעלות של שיחות הצ'אט מופיעים ב-`/admin` → "שימוש וטוקנים" עם הקידומת `chat:` במקום מספר טלפון.
- אותם כללים קבועים ("מעכשיו תמיד...") שנלמדו בטלפון תקפים גם בצ'אט, וגם מהצ'אט אפשר ללמד כללים חדשים.
