/**
 * Admin web page for MAINBOT (Hebrew, RTL). One self-contained HTML document with inline
 * CSS and vanilla JS - no CDN, no web fonts, no external resources. It only talks to the
 * JSON API registered in ./routes.ts (same origin; the browser re-sends the HTTP Basic
 * credentials it already used to load the page).
 *
 * The page source is kept in String.raw templates so escape sequences inside the page's
 * JavaScript (for example '\n') reach the browser untouched. Because of that the page
 * code below must never contain a backtick or the two characters "${".
 */

const CSS = String.raw`
:root {
  --bg: #f4f5f7;
  --card: #ffffff;
  --text: #1f2933;
  --muted: #6b7280;
  --border: #e3e6ea;
  --accent: #2f6bd8;
  --accent-soft: #e8effc;
  --danger: #b42318;
  --ok: #15803d;
  --warn: #b45309;
  --radius: 12px;
  --shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans Hebrew", sans-serif;
  font-size: 15px;
  line-height: 1.5;
}
[hidden] { display: none !important; }
a { color: var(--accent); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; direction: ltr; unicode-bidi: isolate; }
.ltr { direction: ltr; unicode-bidi: isolate; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

header.top { background: var(--card); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 10; }
.top-inner { max-width: 1100px; margin: 0 auto; padding: 12px 16px 4px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.brand { font-weight: 700; font-size: 18px; margin: 0; }
.brand small { color: var(--muted); font-weight: 400; font-size: 13px; margin-inline-start: 8px; }
.chips { display: flex; gap: 8px; flex-wrap: wrap; margin-inline-start: auto; align-items: center; }
.chip { background: var(--bg); border: 1px solid var(--border); border-radius: 999px; padding: 3px 10px; font-size: 13px; color: var(--muted); }
.chip b { color: var(--text); }
nav.tabs { max-width: 1100px; margin: 0 auto; padding: 0 8px; display: flex; gap: 4px; overflow-x: auto; -webkit-overflow-scrolling: touch; }
nav.tabs button { background: none; border: 0; border-bottom: 2px solid transparent; padding: 10px 14px; font: inherit; color: var(--muted); cursor: pointer; white-space: nowrap; }
nav.tabs button[aria-selected="true"] { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }

main { max-width: 1100px; margin: 0 auto; padding: 16px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); padding: 16px; margin-bottom: 16px; }
.card h2 { margin: 0 0 12px; font-size: 17px; }
.grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
.field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.field.wide { grid-column: 1 / -1; }
fieldset { border: 0; padding: 0; margin: 0; min-width: 0; }
legend { padding: 0; margin-bottom: 4px; }
label, legend { font-size: 13px; color: var(--muted); }
input[type="text"], input[type="number"], input[type="password"], select, textarea {
  font: inherit; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: #fff; color: var(--text); width: 100%; max-width: 100%;
}
input[type="number"] { direction: ltr; }
textarea { min-height: 90px; resize: vertical; }
input:focus, select:focus, textarea:focus, button:focus-visible { outline: 2px solid var(--accent-soft); border-color: var(--accent); }
.hint { font-size: 12px; color: var(--muted); }
p.hint { margin: 8px 0 0; }
.check { display: flex; align-items: center; gap: 8px; }
.check input { width: auto; }
.check label { color: var(--text); font-size: 14px; }
.radios { display: flex; flex-direction: column; gap: 6px; }
.radios .opt { display: flex; align-items: center; gap: 8px; }
.radios .opt label { color: var(--text); font-size: 14px; }
.radios code, .opt code { background: var(--bg); padding: 1px 6px; border-radius: 4px; }

button.btn, a.btn {
  font: inherit; font-size: 14px; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--border); background: #fff; color: var(--text); cursor: pointer; text-decoration: none; display: inline-block; line-height: 1.3;
}
button.btn:hover, a.btn:hover { border-color: #c5cbd3; }
button.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.btn.small, a.btn.small { padding: 4px 10px; font-size: 13px; }
button.btn:disabled { opacity: 0.6; cursor: default; }
button.btn[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.savebar { position: sticky; bottom: 0; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 16px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; box-shadow: 0 -2px 8px rgba(16, 24, 40, 0.06); margin-bottom: 16px; }

.table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; max-width: 100%; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: right; vertical-align: top; white-space: nowrap; }
th { color: var(--muted); font-weight: 600; font-size: 13px; }
td.ltr, th.ltr { direction: ltr; unicode-bidi: isolate; }
td.num { font-variant-numeric: tabular-nums; }
td.url-cell { white-space: normal; max-width: 280px; overflow-wrap: anywhere; font-size: 13px; }
td.err-cell { white-space: normal; max-width: 260px; color: var(--danger); font-size: 13px; }
td.empty { white-space: normal; }
tr.clickable { cursor: pointer; }
tr.clickable:hover, tr.clickable:focus { background: var(--bg); outline: none; }

.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; border: 1px solid var(--border); background: var(--bg); color: var(--muted); white-space: nowrap; }
.badge.ok { color: var(--ok); border-color: #bfe3cb; background: #f1faf4; }
.badge.warn { color: var(--warn); border-color: #f1d8a8; background: #fff8e9; }
.badge.err { color: var(--danger); border-color: #f2c4bd; background: #fdf3f1; }
.badge.info { color: var(--accent); border-color: #c9d8f5; background: var(--accent-soft); }
.star { color: var(--warn); }

.kpis { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
.kpi { background: var(--bg); border-radius: 10px; padding: 10px 12px; }
.kpi .v { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }
.kpi .l { font-size: 12px; color: var(--muted); }

.urlbox { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.urlbox code { flex: 1; min-width: 200px; direction: ltr; text-align: left; background: var(--bg); padding: 8px 10px; border-radius: 8px; font-size: 13px; overflow-wrap: anywhere; border: 1px solid var(--border); }

.tools { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
.tools li { font-size: 13px; padding: 6px 8px; background: var(--bg); border-radius: 6px; white-space: normal; }
.tools .d { display: block; color: var(--muted); font-size: 12px; margin-top: 2px; }

.toasts { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; gap: 8px; z-index: 100; max-width: calc(100% - 32px); }
.toast { background: #1f2933; color: #fff; padding: 10px 14px; border-radius: 10px; font-size: 14px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2); animation: fade 0.2s ease-out; overflow-wrap: anywhere; }
.toast.ok { background: var(--ok); }
.toast.err { background: var(--danger); }
@keyframes fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }

.chat { display: flex; flex-direction: column; gap: 10px; min-height: 200px; max-height: 60vh; overflow-y: auto; padding: 4px; }
.msg { max-width: 85%; padding: 8px 12px; border-radius: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
.msg.user { align-self: flex-start; background: var(--accent); color: #fff; }
.msg.bot { align-self: flex-end; background: var(--bg); }
.msg .meta { font-size: 12px; color: var(--muted); margin-top: 4px; white-space: normal; }
.msg .err { color: var(--danger); font-size: 13px; }

pre.prompt { white-space: pre-wrap; overflow-wrap: anywhere; font-family: inherit; font-size: 14px; background: var(--bg); padding: 12px; border-radius: 8px; max-height: 70vh; overflow: auto; margin: 12px 0 0; }

.modal { position: fixed; inset: 0; background: rgba(16, 24, 40, 0.5); display: flex; align-items: center; justify-content: center; padding: 16px; z-index: 50; }
.modal .box { background: var(--card); border-radius: var(--radius); max-width: 900px; width: 100%; max-height: 90vh; display: flex; flex-direction: column; }
.modal .head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.modal .head h2 { margin: 0; font-size: 16px; flex: 1; overflow-wrap: anywhere; }
.modal .body { padding: 16px; overflow: auto; }
.ev { padding: 8px 10px; border-radius: 8px; margin-bottom: 8px; font-size: 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
.ev.turn-user { background: var(--accent-soft); margin-inline-end: 15%; }
.ev.turn-bot { background: var(--bg); margin-inline-start: 15%; }
.ev.tool, .ev.llm, .ev.call { font-size: 13px; color: var(--muted); border: 1px dashed var(--border); white-space: normal; }
.ev .t { font-size: 11px; color: var(--muted); margin-bottom: 2px; }
.empty { color: var(--muted); font-size: 14px; padding: 8px 0; }
.rule { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin-bottom: 8px; display: flex; flex-direction: column; gap: 6px; }
.rule textarea { min-height: 56px; }
.rule .meta { font-size: 12px; color: var(--muted); }

@media (max-width: 640px) {
  body { font-size: 14px; }
  main { padding: 10px; }
  .card { padding: 12px; }
  .msg { max-width: 95%; }
  .ev.turn-user, .ev.turn-bot { margin-inline-start: 0; margin-inline-end: 0; }
  .chips { margin-inline-start: 0; }
}
`;

const BODY = String.raw`
<header class="top">
  <div class="top-inner">
    <h1 class="brand">MAINBOT <small>ניהול העוזר הקולי</small></h1>
    <div class="chips">
      <span class="chip">שיחות פעילות: <b id="hdr-active">–</b></span>
      <span class="chip">כלים זמינים: <b id="hdr-tools">–</b></span>
      <button class="btn small" id="btn-refresh" type="button">רענון</button>
    </div>
  </div>
  <nav class="tabs" role="tablist" aria-label="אזורי הניהול">
    <button type="button" role="tab" data-tab="settings" aria-selected="true">הגדרות</button>
    <button type="button" role="tab" data-tab="connections" aria-selected="false">חיבורים</button>
    <button type="button" role="tab" data-tab="usage" aria-selected="false">שימוש וטוקנים</button>
    <button type="button" role="tab" data-tab="chat" aria-selected="false">בדיקה</button>
    <button type="button" role="tab" data-tab="rules" aria-selected="false">כללים והוראות</button>
    <button type="button" role="tab" data-tab="routines" aria-selected="false">משימות יזומות</button>
    <button type="button" role="tab" data-tab="prompt" aria-selected="false">פרומפט</button>
  </nav>
</header>

<main>

<section data-panel="settings" role="tabpanel">
<form id="settings-form" novalidate>
  <div class="card">
    <h2>מודל</h2>
    <div class="grid">
      <div class="field wide">
        <label for="f-model">מודל</label>
        <select id="f-model"></select>
        <span class="hint" id="model-hint"></span>
      </div>
      <fieldset class="field wide">
        <legend>רמת מאמץ (effort)</legend>
        <div class="radios">
          <div class="opt"><input type="radio" name="effort" id="f-effort-low" value="low"><label for="f-effort-low"><code>low</code> מהיר וזול</label></div>
          <div class="opt"><input type="radio" name="effort" id="f-effort-medium" value="medium"><label for="f-effort-medium"><code>medium</code> מאוזן</label></div>
          <div class="opt"><input type="radio" name="effort" id="f-effort-high" value="high"><label for="f-effort-high"><code>high</code> יסודי</label></div>
          <div class="opt"><input type="radio" name="effort" id="f-effort-xhigh" value="xhigh"><label for="f-effort-xhigh"><code>xhigh</code> מעמיק</label></div>
          <div class="opt"><input type="radio" name="effort" id="f-effort-max" value="max"><label for="f-effort-max"><code>max</code> מקסימום דיוק, יקר ואיטי</label></div>
        </div>
      </fieldset>
      <div class="field">
        <label for="f-maxTokens">מקסימום טוקנים לתשובה (256–64000)</label>
        <input type="number" id="f-maxTokens" min="256" max="64000" step="1">
      </div>
      <div class="field">
        <label for="f-maxIterationsPerTurn">מקסימום סבבי מודל בתור אחד (1–50)</label>
        <input type="number" id="f-maxIterationsPerTurn" min="1" max="50" step="1">
        <span class="hint">כל קריאת כלי היא סבב נוסף מול המודל בתוך אותו תור של המתקשר.</span>
      </div>
      <div class="field">
        <label for="f-fallbacks">מודל חלופי בסירוב (fallbacks)</label>
        <select id="f-fallbacks">
          <option value="default">default – מעבר אוטומטי למודל חלופי</option>
          <option value="off">off – ללא מודל חלופי</option>
        </select>
        <span class="hint">כאשר המודל מסרב לענות, Anthropic יכולה לנסות בצד השרת מודל חלופי במקום להחזיר סירוב.</span>
      </div>
      <div class="field">
        <div class="check"><input type="checkbox" id="f-toolSearch"><label for="f-toolSearch">חיפוש כלים – טעינת כלים לפי דרישה</label></div>
        <span class="hint">כשהאפשרות פעילה המודל מקבל כלי חיפוש וכמה כלים קבועים בלבד, ושולף כלים נוספים לפי הצורך – חוסך טוקנים כשיש מאות כלים.</span>
      </div>
      <div class="field">
        <label for="f-toolSearchVariant">שיטת חיפוש כלים</label>
        <select id="f-toolSearchVariant">
          <option value="regex">regex – ביטוי רגולרי</option>
          <option value="bm25">bm25 – חיפוש טקסט חופשי</option>
        </select>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>שיחה וקול</h2>
    <div class="grid">
      <div class="field">
        <label for="f-ttsVoice">קול להקראה</label>
        <select id="f-ttsVoice"></select>
      </div>
      <div class="field">
        <label for="f-fillerMode">בזמן שהעוזר חושב</label>
        <select id="f-fillerMode">
          <option value="tts">tts – הודעת המתנה מוקראת ("רק רגע, אני בודק")</option>
          <option value="music">music – מוזיקת ההמתנה של המרכזייה</option>
          <option value="silence">silence – שקט</option>
        </select>
      </div>
      <div class="field wide">
        <label for="f-greeting">ברכת פתיחה</label>
        <input type="text" id="f-greeting">
      </div>
      <div class="field wide">
        <label for="f-goodbye">ברכת סיום</label>
        <input type="text" id="f-goodbye">
      </div>
      <div class="field">
        <label for="f-sttMaxSeconds">משך הקלטה מקסימלי לזיהוי דיבור (שניות, 1–10)</label>
        <input type="number" id="f-sttMaxSeconds" min="1" max="10" step="1">
      </div>
      <div class="field">
        <label for="f-maxTurns">מקסימום תורות בשיחה (1–500)</label>
        <input type="number" id="f-maxTurns" min="1" max="500" step="1">
      </div>
      <div class="field">
        <label for="f-maxSilentTurns">מקסימום תורות שקטים ברצף (1–10)</label>
        <input type="number" id="f-maxSilentTurns" min="1" max="10" step="1">
        <span class="hint">אחרי כמה תורות ללא דיבור השיחה מסתיימת.</span>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>גישה ואבטחה</h2>
    <div class="grid">
      <div class="field wide">
        <label for="f-allowedPhones">מספרי טלפון מורשים (מספר בכל שורה; * מאפשר לכולם)</label>
        <textarea id="f-allowedPhones" dir="ltr" rows="3"></textarea>
      </div>
      <div class="field">
        <label for="f-pin">קוד גישה חדש (PIN)</label>
        <input type="password" id="f-pin" inputmode="numeric" autocomplete="new-password" placeholder="השאירו ריק כדי לא לשנות">
        <div class="row"><span class="hint" id="pin-status">–</span><button type="button" class="btn small" id="btn-clear-pin">נקה קוד</button></div>
      </div>
      <div class="field">
        <label for="f-maxPinAttempts">מספר ניסיונות קוד מקסימלי (1–10)</label>
        <input type="number" id="f-maxPinAttempts" min="1" max="10" step="1">
      </div>
      <div class="field wide">
        <div class="check"><input type="checkbox" id="f-confirmWrites"><label for="f-confirmWrites">לבקש אישור מהמתקשר לפני פעולות כתיבה (שליחה, עדכון, מחיקה)</label></div>
      </div>
      <div class="field wide">
        <label for="f-blockedTools">כלים חסומים (ביטוי רגולרי בכל שורה, מול השם המלא של הכלי)</label>
        <textarea id="f-blockedTools" dir="ltr" rows="4"></textarea>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>התראות לבעל העסק ומשימות יזומות</h2>
    <div class="grid">
      <div class="field wide">
        <div class="check"><input type="checkbox" id="f-routinesEnabled"><label for="f-routinesEnabled">להריץ משימות יזומות לפי לוח הזמנים (כיבוי עוצר את כולן, בלי למחוק)</label></div>
      </div>
      <div class="field">
        <label for="f-ownerPhone">הטלפון של בעל העסק (לוואטסאפ / SMS)</label>
        <input type="tel" id="f-ownerPhone" dir="ltr" placeholder="0501234567">
      </div>
      <div class="field">
        <label for="f-ownerEmail">האימייל של בעל העסק</label>
        <input type="email" id="f-ownerEmail" dir="ltr" placeholder="owner@example.com">
      </div>
      <div class="field">
        <label for="f-notifyChannel">ערוץ ברירת מחדל להתראות</label>
        <select id="f-notifyChannel">
          <option value="log">log – רק ביומן (בלי שליחה)</option>
          <option value="whatsapp">whatsapp – וואטסאפ דרך ה-CRM</option>
          <option value="sms">sms – SMS דרך ימות המשיח</option>
          <option value="email">email – אימייל דרך ה-CRM</option>
        </select>
        <div class="row"><span class="hint">שמרו קודם, ואז:</span><button type="button" class="btn small" id="btn-notify-test">שלח הודעת בדיקה</button></div>
      </div>
      <div class="field">
        <label for="f-quietFrom">שעות שקט (משימות מתוזמנות לא רצות)</label>
        <div class="row"><input type="time" id="f-quietFrom" style="flex:1"><span>עד</span><input type="time" id="f-quietTo" style="flex:1"></div>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>הנחיות נוספות</h2>
    <div class="grid">
      <div class="field wide">
        <label for="f-extraInstructions">הנחיות נוספות למודל (מצורפות לפרומפט המערכת)</label>
        <textarea id="f-extraInstructions" rows="6"></textarea>
      </div>
    </div>
  </div>

  <div class="savebar">
    <button type="submit" class="btn primary" id="btn-save">שמור</button>
    <span class="hint">השינויים נכנסים לתוקף מיד, גם לשיחות הבאות.</span>
  </div>
</form>
</section>

<section data-panel="connections" role="tabpanel" hidden>
  <div class="card">
    <h2>חיבור לטכנוליין</h2>
    <div class="urlbox"><code id="webhook-url">–</code><button type="button" class="btn small" id="btn-copy">העתק</button></div>
    <p class="hint">הגדירו שלוחת API בטכנוליין עם הכתובת הזו (GET)</p>
  </div>
  <div class="card">
    <h2>שיחות פעילות</h2>
    <div id="active-calls"><div class="empty">טוען...</div></div>
  </div>
  <div class="card">
    <h2>שרתי MCP</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>שרת</th><th>כתובת</th><th>מצב</th><th>כלים</th><th>אימות</th><th>שגיאה</th><th>פעולות</th></tr></thead>
        <tbody id="servers"><tr><td colspan="7" class="empty">טוען...</td></tr></tbody>
      </table>
    </div>
  </div>
</section>

<section data-panel="usage" role="tabpanel" hidden>
  <div class="row" id="usage-ranges" role="group" aria-label="טווח זמן" style="margin-bottom:12px">
    <button type="button" class="btn small" data-range="today" aria-pressed="false">היום</button>
    <button type="button" class="btn small" data-range="7d" aria-pressed="true">7 ימים</button>
    <button type="button" class="btn small" data-range="30d" aria-pressed="false">30 ימים</button>
    <button type="button" class="btn small" data-range="all" aria-pressed="false">הכל</button>
  </div>
  <div class="card">
    <div class="kpis" id="kpis"><div class="empty">טוען...</div></div>
    <p class="hint">העלות היא הערכה לפי מחירון Anthropic הרשמי; החיוב בפועל מופיע בקונסול של Anthropic</p>
  </div>
  <div class="card"><h2>לפי מודל</h2><div class="table-wrap" id="by-model"></div></div>
  <div class="card"><h2>לפי יום</h2><div class="table-wrap" id="by-day"></div></div>
  <div class="card"><h2>לפי כלי</h2><div class="table-wrap" id="by-tool"></div></div>
  <div class="card"><h2>שיחות</h2><p class="hint" style="margin:0 0 8px">לחיצה על שיחה פותחת את התמליל המלא.</p><div class="table-wrap" id="calls"></div></div>
</section>

<section data-panel="chat" role="tabpanel" hidden>
  <div class="card">
    <h2>בדיקה בטקסט</h2>
    <p class="hint" style="margin:0 0 12px">אותו עוזר, אותם כלים – בלי טלפון. פעולות כתיבה מבקשות אישור כמו בשיחה.</p>
    <div class="chat" id="chat-log"></div>
    <form id="chat-form" class="row" style="margin-top:12px">
      <label for="chat-input" class="sr-only">הודעה לעוזר</label>
      <input type="text" id="chat-input" placeholder="כתבו הודעה לעוזר..." autocomplete="off" style="flex:1;min-width:200px">
      <button type="submit" class="btn primary" id="btn-send">שלח</button>
      <button type="button" class="btn" id="btn-new-chat">שיחה חדשה</button>
    </form>
  </div>
</section>

<section data-panel="rules" role="tabpanel" hidden>
  <div class="card">
    <h2>כללים קבועים</h2>
    <p class="hint" style="margin:0 0 12px">כללים שבעל העסק מכתיב ("מעכשיו תמיד..."), נשמרים לדיסק ונכנסים לפרומפט של כל שיחה. עד 200 כללים, עד 600 תווים לכלל.</p>
    <div id="rules-list"><div class="empty">טוען...</div></div>
    <form id="rule-add-form" class="field" style="margin-top:12px">
      <label for="rule-new">כלל חדש</label>
      <textarea id="rule-new" rows="2" maxlength="600" placeholder="לדוגמה: תמיד לשאול לשם המלא לפני שליחת הצעת מחיר"></textarea>
      <div class="row"><button type="submit" class="btn primary" id="btn-rule-add">הוסף כלל</button></div>
    </form>
  </div>
  <div class="card">
    <div class="row"><h2 style="margin:0;flex:1">הוראות עסקיות (instructions.md)</h2><span class="chip">תווים: <b id="instr-chars">–</b></span></div>
    <p class="hint" style="margin:8px 0 12px">הקובץ שמתאר את העסק, השירותים והנהלים – חלק מפרומפט המערכת. השמירה מרעננת את הפרומפט מיד.</p>
    <div class="field">
      <label for="instr-text">תוכן הקובץ</label>
      <textarea id="instr-text" rows="16"></textarea>
    </div>
    <div class="row" style="margin-top:12px"><button type="button" class="btn primary" id="btn-instr-save">שמור הוראות</button><button type="button" class="btn" id="btn-instr-reload">טען מחדש</button></div>
  </div>
</section>

<section data-panel="routines" role="tabpanel" hidden>
  <div class="card">
    <div class="row">
      <h2 style="margin:0;flex:1">משימות יזומות</h2>
      <span class="chip" id="routines-status">–</span>
      <button type="button" class="btn small" id="btn-routines-reload">רענון</button>
    </div>
    <p class="hint" style="margin:8px 0 12px">העוזר מריץ בעצמו בדיקות לפי לוח זמנים או כשמגיע אירוע מהמערכת, קורא מהמערכות (בלי לבצע פעולות) ושולח לכם הודעה רק כשיש משהו שדורש תשומת לב – עם הצעות לפעולה שתאשרו בשיחה או בצ'אט. אפשר גם ליצור משימה בטלפון: "כל בוקר תשלח לי...".</p>
    <div id="routines-list"><div class="empty">טוען...</div></div>
  </div>

  <div class="card">
    <div class="row"><h2 style="margin:0;flex:1" id="routine-form-title">משימה חדשה</h2>
      <label for="rt-example" class="sr-only">דוגמאות</label>
      <select id="rt-example"><option value="">דוגמאות מוכנות...</option></select>
    </div>
    <form id="routine-form" style="margin-top:12px">
      <input type="hidden" id="rt-id" value="">
      <div class="grid">
        <div class="field">
          <label for="rt-name">שם המשימה</label>
          <input type="text" id="rt-name" maxlength="80" required placeholder="לדוגמה: תדריך בוקר">
        </div>
        <div class="field">
          <label for="rt-channel">לאן לשלוח את ההודעה</label>
          <select id="rt-channel">
            <option value="log">log – רק ביומן</option>
            <option value="whatsapp">whatsapp – וואטסאפ</option>
            <option value="sms">sms – SMS</option>
            <option value="email">email – אימייל</option>
          </select>
        </div>
        <div class="field">
          <label for="rt-kind">מתי לרוץ</label>
          <select id="rt-kind">
            <option value="cron">לפי לוח זמנים</option>
            <option value="interval">כל כמה דקות</option>
            <option value="event">כשמגיע אירוע מהמערכת (webhook)</option>
            <option value="manual">ידני בלבד</option>
          </select>
        </div>
        <div class="field" data-kind="cron">
          <label for="rt-preset">לוח זמנים</label>
          <select id="rt-preset">
            <option value="0 8 * * *">כל יום ב-08:00</option>
            <option value="0 9 * * 0-4">ימים א'–ה' ב-09:00</option>
            <option value="0 20 * * 0-4">ימים א'–ה' ב-20:00</option>
            <option value="0 9-18 * * 0-4">כל שעה עגולה בין 9 ל-18, א'–ה'</option>
            <option value="0 12 * * 5">כל יום שישי ב-12:00</option>
            <option value="0 9 1 * *">ב-1 לכל חודש ב-09:00</option>
            <option value="custom">מותאם אישית...</option>
          </select>
        </div>
        <div class="field" data-kind="cron">
          <label for="rt-cron">ביטוי cron (דקה שעה יום חודש יום-בשבוע; 0 = ראשון; שעון ישראל)</label>
          <input type="text" id="rt-cron" dir="ltr" value="0 8 * * *" placeholder="0 8 * * *">
        </div>
        <div class="field" data-kind="interval" hidden>
          <label for="rt-every">כל כמה דקות (5–10080)</label>
          <input type="number" id="rt-every" min="5" max="10080" step="1" value="60">
        </div>
        <div class="field wide" data-kind="event" hidden>
          <label for="rt-events">סוגי אירועים (מופרדים בפסיק; * = כל אירוע)</label>
          <input type="text" id="rt-events" dir="ltr" placeholder="new_lead, payment_received">
          <span class="hint">המערכת החיצונית שולחת POST /api/v1/events עם {"type": "new_lead", "payload": {...}} ועם מפתח ה-Chat API.</span>
        </div>
        <div class="field wide">
          <label for="rt-prompt">ההנחיה: מה לבדוק, מתי שווה להודיע, מה להציע</label>
          <textarea id="rt-prompt" rows="5" maxlength="4000" placeholder="לדוגמה: בדוק ב-CRM את הלידים שלא קיבלו מענה מעל 24 שעות. אם יש כאלה, שלח לי רשימה קצרה (שם, טלפון, מה ביקשו) והצע למי כדאי לחזור קודם."></textarea>
        </div>
        <div class="field wide">
          <div class="check"><input type="checkbox" id="rt-quiet"><label for="rt-quiet">שעות שקט מיוחדות למשימה זו (אחרת לפי ההגדרות הכלליות)</label></div>
          <div class="row" id="rt-quiet-row" hidden><input type="time" id="rt-quiet-from" value="22:00"><span>עד</span><input type="time" id="rt-quiet-to" value="07:00"></div>
        </div>
      </div>
      <div class="row" style="margin-top:12px">
        <button type="submit" class="btn primary" id="btn-rt-save">שמור משימה</button>
        <button type="button" class="btn" id="btn-rt-cancel" hidden>ביטול עריכה</button>
      </div>
    </form>
  </div>

  <div class="card">
    <h2>הודעות אחרונות לבעל העסק</h2>
    <div class="table-wrap" id="notifications"><div class="empty">טוען...</div></div>
  </div>
</section>

<section data-panel="prompt" role="tabpanel" hidden>
  <div class="card">
    <div class="row">
      <h2 style="margin:0;flex:1">פרומפט המערכת</h2>
      <span class="chip">תווים: <b id="prompt-chars">–</b></span>
      <button type="button" class="btn small" id="btn-prompt-reload">טען מחדש</button>
    </div>
    <pre dir="rtl" class="prompt" id="prompt-text">טוען...</pre>
  </div>
</section>

</main>

<div class="modal" id="call-modal" hidden role="dialog" aria-modal="true" aria-labelledby="modal-title">
  <div class="box">
    <div class="head"><h2 id="modal-title">שיחה</h2><button type="button" class="btn small" id="modal-close">סגור</button></div>
    <div class="body" id="modal-body"></div>
  </div>
</div>
<div class="toasts" id="toasts" aria-live="polite"></div>
`;

const SCRIPT = String.raw`
(function () {
  'use strict';

  var state = null;
  var chatSessionId = null;
  var usageRange = '7d';
  var usageLoaded = false;
  var promptLoaded = false;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function fmt(n) { var v = Number(n); return isFinite(v) ? v.toLocaleString('he-IL') : '0'; }
  function money(n) { var v = Number(n); return '$' + (isFinite(v) ? v : 0).toFixed(4); }
  function dash(v) { return v === null || v === undefined || v === '' ? '–' : String(v); }
  function when(ts) {
    if (!ts) return '–';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return String(ts);
    try { return d.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }); } catch (e) { return d.toLocaleString('he-IL'); }
  }
  function wait(msec) { return new Promise(function (resolve) { setTimeout(resolve, msec); }); }

  function toast(msg, kind) {
    var box = $('#toasts');
    if (!box) return;
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, kind === 'err' ? 7000 : 4000);
  }

  async function api(method, url, body) {
    var opts = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    var res = await fetch(url, opts);
    var ct = res.headers.get('content-type') || '';
    var data;
    if (ct.indexOf('application/json') >= 0) { try { data = await res.json(); } catch (e) { data = null; } }
    else data = await res.text();
    if (!res.ok) {
      var m = '';
      if (data && typeof data === 'object') m = data.error || data.message || '';
      else if (typeof data === 'string') m = data.trim().slice(0, 300);
      throw new Error(m || ('HTTP ' + res.status));
    }
    return data;
  }

  /* ------------------------------ tabs ------------------------------ */

  function showTab(name) {
    var found = false;
    $$('nav.tabs button').forEach(function (b) {
      var on = b.getAttribute('data-tab') === name;
      if (on) found = true;
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (!found) { showTab('settings'); return; }
    $$('main section[data-panel]').forEach(function (s) { s.hidden = s.getAttribute('data-panel') !== name; });
    try { history.replaceState(null, '', location.pathname + '#' + name); } catch (e) { /* ignore */ }
    if (name === 'usage' && !usageLoaded) loadUsage();
    if (name === 'prompt' && !promptLoaded) loadPrompt();
    if (name === 'rules' && !rulesLoaded) { loadRules(); loadInstructions(); }
    if (name === 'routines' && !routinesLoaded) loadRoutines();
  }

  /* ------------------------------ state ------------------------------ */

  async function loadState(form) {
    try {
      state = await api('GET', '/admin/api/state');
      renderHeader();
      if (form) fillSettings();
      renderActiveCalls();
      renderServers();
      $('#webhook-url').textContent = state.webhookUrl || '';
    } catch (e) {
      toast('טעינת המצב נכשלה: ' + e.message, 'err');
    }
  }

  function renderHeader() {
    $('#hdr-active').textContent = fmt((state.activeCalls || []).length);
    $('#hdr-tools').textContent = fmt(state.toolCount);
  }

  /* ------------------------------ settings ------------------------------ */

  var NUM_FIELDS = [
    ['maxTokens', 'מקסימום טוקנים לתשובה', 256, 64000],
    ['maxIterationsPerTurn', 'מקסימום סבבי מודל בתור', 1, 50],
    ['maxPinAttempts', 'מספר ניסיונות קוד', 1, 10],
    ['sttMaxSeconds', 'משך הקלטה מקסימלי', 1, 10],
    ['maxTurns', 'מקסימום תורות בשיחה', 1, 500],
    ['maxSilentTurns', 'מקסימום תורות שקטים', 1, 10]
  ];

  function setOptions(select, items, current, missingLabel) {
    var html = '';
    var found = false;
    items.forEach(function (it) {
      if (it.id === current) found = true;
      html += '<option value="' + esc(it.id) + '">' + esc(it.label) + '</option>';
    });
    if (!found && current) html += '<option value="' + esc(current) + '">' + esc(current + ' ' + missingLabel) + '</option>';
    select.innerHTML = html;
    select.value = current || '';
  }

  function modelHint() {
    var id = $('#f-model').value;
    var m = ((state && state.models) || []).filter(function (x) { return x.id === id; })[0];
    $('#model-hint').textContent = m
      ? 'קלט $' + m.input + ' · פלט $' + m.output + ' · כתיבה לקאש $' + m.cacheWrite + ' · קריאה מקאש $' + m.cacheRead + ' ל-1M טוקנים · חלון הקשר ' + m.context
      : 'מודל שאינו במחירון – העלות המשוערת לא תחושב עבורו';
  }

  function fillSettings() {
    var s = state.settings || {};
    setOptions($('#f-model'), (state.models || []).map(function (m) {
      return { id: m.id, label: m.label + ' · $' + m.input + ' / $' + m.output + ' ל-1M טוקנים' };
    }), s.model, '(לא במחירון)');
    modelHint();
    $$('input[name="effort"]').forEach(function (r) { r.checked = r.value === s.effort; });
    NUM_FIELDS.forEach(function (f) { $('#f-' + f[0]).value = s[f[0]] == null ? '' : s[f[0]]; });
    $('#f-fallbacks').value = s.fallbacks || 'default';
    $('#f-toolSearch').checked = !!s.toolSearch;
    $('#f-toolSearchVariant').value = s.toolSearchVariant || 'regex';
    setOptions($('#f-ttsVoice'), state.voices || [], s.ttsVoice || '', '(לא ברשימה)');
    $('#f-fillerMode').value = s.fillerMode || 'tts';
    $('#f-greeting').value = s.greeting || '';
    $('#f-goodbye').value = s.goodbye || '';
    $('#f-allowedPhones').value = (s.allowedPhones || []).join('\n');
    $('#f-blockedTools').value = (s.blockedTools || []).join('\n');
    $('#f-confirmWrites').checked = !!s.confirmWrites;
    $('#f-extraInstructions').value = s.extraInstructions || '';
    $('#f-routinesEnabled').checked = s.routinesEnabled !== false;
    $('#f-ownerPhone').value = s.ownerPhone || '';
    $('#f-ownerEmail').value = s.ownerEmail || '';
    $('#f-notifyChannel').value = s.notifyChannel || 'log';
    $('#f-quietFrom').value = hhmm((s.quietHours || {}).from || '22:00');
    $('#f-quietTo').value = hhmm((s.quietHours || {}).to || '07:00');
    $('#f-pin').value = '';
    $('#pin-status').textContent = s.hasPin ? 'מוגדר קוד גישה.' : 'לא מוגדר קוד גישה.';
    $('#btn-clear-pin').disabled = !s.hasPin;
  }

  function lines(text) {
    return String(text || '').split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 0; });
  }

  function collectSettings() {
    var out = {};
    out.model = $('#f-model').value;
    if (!out.model) throw new Error('יש לבחור מודל');
    var eff = $$('input[name="effort"]').filter(function (r) { return r.checked; })[0];
    out.effort = eff ? eff.value : state.settings.effort;
    NUM_FIELDS.forEach(function (f) {
      var raw = $('#f-' + f[0]).value;
      var v = Number(raw);
      if (raw === '' || !isFinite(v) || Math.floor(v) !== v || v < f[2] || v > f[3]) {
        throw new Error(f[1] + ': יש להזין מספר שלם בין ' + f[2] + ' ל-' + f[3]);
      }
      out[f[0]] = v;
    });
    out.fallbacks = $('#f-fallbacks').value;
    out.toolSearch = $('#f-toolSearch').checked;
    out.toolSearchVariant = $('#f-toolSearchVariant').value;
    out.ttsVoice = $('#f-ttsVoice').value;
    out.fillerMode = $('#f-fillerMode').value;
    out.greeting = $('#f-greeting').value;
    out.goodbye = $('#f-goodbye').value;
    out.allowedPhones = lines($('#f-allowedPhones').value);
    out.blockedTools = lines($('#f-blockedTools').value);
    out.blockedTools.forEach(function (p) {
      try { new RegExp(p); } catch (e) { throw new Error('ביטוי רגולרי לא תקין בכלים חסומים: ' + p); }
    });
    out.confirmWrites = $('#f-confirmWrites').checked;
    out.extraInstructions = $('#f-extraInstructions').value;
    out.routinesEnabled = $('#f-routinesEnabled').checked;
    out.ownerPhone = $('#f-ownerPhone').value.trim();
    out.ownerEmail = $('#f-ownerEmail').value.trim();
    out.notifyChannel = $('#f-notifyChannel').value;
    var qf = $('#f-quietFrom').value, qt = $('#f-quietTo').value;
    if (!/^\d{1,2}:\d{2}$/.test(qf) || !/^\d{1,2}:\d{2}$/.test(qt)) throw new Error('שעות שקט: יש להזין שעה בפורמט HH:MM');
    out.quietHours = { from: qf, to: qt };
    return out;
  }

  /** <input type=time> wants HH:MM with two-digit hours. */
  function hhmm(v) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(v || ''));
    if (!m) return '';
    return (m[1].length === 1 ? '0' + m[1] : m[1]) + ':' + m[2];
  }

  async function notifyTest() {
    var btn = $('#btn-notify-test');
    var channel = $('#f-notifyChannel').value;
    if (state && state.settings && state.settings.notifyChannel !== channel) { toast('שמרו את ההגדרות קודם – הבדיקה משתמשת בערוץ השמור', 'err'); return; }
    btn.disabled = true;
    try {
      var r = await api('POST', '/admin/api/notify/test', { channel: channel });
      if (r && r.ok) toast('נשלח בערוץ ' + r.channel + (r.detail ? ' – ' + r.detail : ''), 'ok');
      else toast('השליחה נכשלה (' + ((r && r.channel) || channel) + '): ' + ((r && r.detail) || ''), 'err');
    } catch (e) {
      toast('השליחה נכשלה: ' + e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  async function saveSettings() {
    if (!state || !state.settings) { toast('ההגדרות עדיין לא נטענו', 'err'); return; }
    var next;
    try { next = collectSettings(); } catch (e) { toast(e.message, 'err'); return; }
    var orig = state.settings;
    var patch = {};
    var changed = 0;
    Object.keys(next).forEach(function (k) {
      if (JSON.stringify(next[k]) !== JSON.stringify(orig[k])) { patch[k] = next[k]; changed++; }
    });
    var pin = $('#f-pin').value;
    if (pin) { patch.pin = pin; changed++; }
    if (!changed) { toast('אין שינויים לשמירה'); return; }
    var btn = $('#btn-save');
    btn.disabled = true;
    try {
      await api('PUT', '/admin/api/settings', patch);
      toast('ההגדרות נשמרו', 'ok');
      await loadState(true);
    } catch (e) {
      toast('השמירה נכשלה: ' + e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  async function clearPin() {
    if (!window.confirm('לנקות את קוד הגישה? כל מתקשר מורשה ייכנס ללא קוד.')) return;
    var btn = $('#btn-clear-pin');
    btn.disabled = true;
    try {
      await api('PUT', '/admin/api/settings', { pin: '' });
      toast('קוד הגישה נוקה', 'ok');
      await loadState(false);
      var s = state && state.settings;
      $('#f-pin').value = '';
      $('#pin-status').textContent = s && s.hasPin ? 'מוגדר קוד גישה.' : 'לא מוגדר קוד גישה.';
      btn.disabled = !(s && s.hasPin);
    } catch (e) {
      toast('ניקוי הקוד נכשל: ' + e.message, 'err');
      btn.disabled = false;
    }
  }

  /* ------------------------------ connections ------------------------------ */

  var STATES = {
    connected: ['מחובר', 'ok'],
    connecting: ['מתחבר', 'info'],
    needs_login: ['נדרשת התחברות', 'warn'],
    error: ['שגיאה', 'err'],
    disconnected: ['מנותק', ''],
    disabled: ['כבוי', '']
  };

  function renderActiveCalls() {
    var box = $('#active-calls');
    var calls = state.activeCalls || [];
    if (!calls.length) { box.innerHTML = '<div class="empty">אין שיחות פעילות כרגע.</div>'; return; }
    var rows = calls.map(function (c) {
      return '<tr>' +
        '<td class="ltr">' + esc(dash(c.phone)) + '</td>' +
        '<td>' + esc(when(c.startedAt)) + '</td>' +
        '<td class="num">' + fmt(c.turns) + '</td>' +
        '<td>' + (c.thinking ? '<span class="badge info">חושב...</span>' : '<span class="badge">ממתין למתקשר</span>') + '</td>' +
        '<td class="ltr"><span class="hint">' + esc(c.callId) + '</span></td>' +
        '</tr>';
    }).join('');
    box.innerHTML = '<div class="table-wrap"><table><thead><tr><th>טלפון</th><th>התחילה</th><th>תורות</th><th>מצב</th><th>מזהה</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function renderServers() {
    var tbody = $('#servers');
    var servers = state.servers || [];
    if (!servers.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">לא הוגדרו שרתי MCP (config/mcp-servers.json).</td></tr>';
      return;
    }
    tbody.innerHTML = servers.map(function (s) {
      var st = STATES[s.state] || [s.state, ''];
      var tools = s.tools || [];
      var oauth = s.authType === 'oauth';
      var acts = '';
      if (oauth) acts += '<a class="btn small" href="/admin/mcp/' + encodeURIComponent(s.name) + '/login">התחבר</a>';
      acts += '<button type="button" class="btn small" data-act="reconnect" data-name="' + esc(s.name) + '">חבר מחדש</button>';
      if (oauth) acts += '<button type="button" class="btn small" data-act="logout" data-name="' + esc(s.name) + '">התנתק</button>';
      if (tools.length) acts += '<button type="button" class="btn small" data-act="tools" data-name="' + esc(s.name) + '" aria-expanded="false">כלים (' + fmt(tools.length) + ')</button>';
      var list = tools.map(function (t) {
        var write = t.kind === 'write';
        return '<li>' +
          (t.alwaysLoad ? '<span class="star" title="נטען תמיד, ללא חיפוש">★</span> ' : '') +
          '<code>' + esc(t.name) + '</code> ' +
          '<span class="badge ' + (write ? 'warn' : '') + '">' + (write ? 'פעולה' : 'קריאה') + '</span>' +
          (t.description ? '<span class="d">' + esc(t.description) + '</span>' : '') +
          '</li>';
      }).join('');
      var info = s.serverInfo ? ' · ' + esc((s.serverInfo.name || '') + ' ' + (s.serverInfo.version || '')) : '';
      return '<tr>' +
        '<td><b>' + esc(s.label || s.name) + '</b><div class="hint ltr">' + esc(s.name) + info + '</div></td>' +
        '<td class="ltr url-cell">' + esc(s.url) + '</td>' +
        '<td><span class="badge ' + st[1] + '">' + esc(st[0]) + '</span>' + (s.connectedAt ? '<div class="hint">' + esc(when(s.connectedAt)) + '</div>' : '') + '</td>' +
        '<td class="num">' + fmt(s.toolCount) + '</td>' +
        '<td class="ltr">' + esc(s.authType) + '</td>' +
        '<td class="err-cell">' + esc(s.error || '') + '</td>' +
        '<td><div class="row">' + acts + '</div></td>' +
        '</tr>' +
        '<tr data-tools="' + esc(s.name) + '" hidden><td colspan="7"><ul class="tools">' + list + '</ul></td></tr>';
    }).join('');
  }

  async function serverAction(e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var name = btn.getAttribute('data-name');
    var act = btn.getAttribute('data-act');
    if (act === 'tools') {
      var row = $$('#servers tr[data-tools]').filter(function (r) { return r.getAttribute('data-tools') === name; })[0];
      if (row) { row.hidden = !row.hidden; btn.setAttribute('aria-expanded', row.hidden ? 'false' : 'true'); }
      return;
    }
    if (act !== 'reconnect' && act !== 'logout') return;
    if (act === 'logout' && !window.confirm('להתנתק מהשרת "' + name + '"? יידרש להתחבר מחדש.')) return;
    btn.disabled = true;
    try {
      await api('POST', '/admin/api/mcp/' + encodeURIComponent(name) + '/' + act);
      toast(act === 'logout' ? 'ההתנתקות בוצעה' : 'החיבור חודש', 'ok');
      if (act === 'logout') await wait(500);
    } catch (err) {
      toast('הפעולה נכשלה: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
      await loadState(false);
    }
  }

  async function copyWebhook() {
    var text = $('#webhook-url').textContent || '';
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (!ok) throw new Error('copy failed');
      }
      toast('הכתובת הועתקה', 'ok');
    } catch (e) {
      toast('ההעתקה נכשלה – סמנו והעתיקו ידנית', 'err');
    }
  }

  /* ------------------------------ usage ------------------------------ */

  function td(v, cls) { return '<td' + (cls ? ' class="' + cls + '"' : '') + '>' + v + '</td>'; }
  function tokCells(t) {
    t = t || {};
    return td(fmt(t.inputTokens), 'num') + td(fmt(t.outputTokens), 'num') + td(fmt(t.cacheReadTokens), 'num') + td(fmt(t.cacheWriteTokens), 'num');
  }
  function table(headers, rows) {
    if (!rows.length) return '<div class="empty">אין נתונים בטווח הזה.</div>';
    return '<table><thead><tr>' + headers.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table>';
  }

  async function loadUsage() {
    $$('#usage-ranges button').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-range') === usageRange ? 'true' : 'false'); });
    try {
      var u = await api('GET', '/admin/api/usage?range=' + encodeURIComponent(usageRange));
      usageLoaded = true;
      renderUsage(u || {});
    } catch (e) {
      toast('טעינת נתוני השימוש נכשלה: ' + e.message, 'err');
    }
  }

  function renderUsage(u) {
    var a = u.aggregate || {};
    var t = a.tokens || {};
    var kpis = [
      ['שיחות', fmt(a.calls)],
      ['תורות', fmt(a.turns)],
      ['בקשות למודל', fmt(a.llmRequests)],
      ['קריאות כלים', fmt(a.toolCalls)],
      ['טוקני קלט', fmt(t.inputTokens)],
      ['טוקני פלט', fmt(t.outputTokens)],
      ['קריאה מקאש', fmt(t.cacheReadTokens)],
      ['כתיבה לקאש', fmt(t.cacheWriteTokens)],
      ['עלות משוערת', money(a.costUsd)]
    ];
    $('#kpis').innerHTML = kpis.map(function (k) {
      return '<div class="kpi"><div class="v">' + esc(k[1]) + '</div><div class="l">' + esc(k[0]) + '</div></div>';
    }).join('');

    $('#by-model').innerHTML = table(['מודל', 'בקשות', 'קלט', 'פלט', 'קריאה מקאש', 'כתיבה לקאש', 'עלות'], (a.byModel || []).map(function (r) {
      return '<tr>' + td(esc(r.model), 'ltr') + td(fmt(r.requests), 'num') + tokCells(r.tokens) + td(money(r.costUsd), 'num') + '</tr>';
    }));
    $('#by-day').innerHTML = table(['יום', 'שיחות', 'בקשות', 'קלט', 'פלט', 'קריאה מקאש', 'כתיבה לקאש', 'עלות'], (a.byDay || []).map(function (r) {
      return '<tr>' + td(esc(r.day), 'ltr') + td(fmt(r.calls), 'num') + td(fmt(r.requests), 'num') + tokCells(r.tokens) + td(money(r.costUsd), 'num') + '</tr>';
    }));
    $('#by-tool').innerHTML = table(['כלי', 'קריאות', 'כשלים'], (a.byTool || []).map(function (r) {
      return '<tr>' + td(esc(r.tool), 'ltr') + td(fmt(r.calls), 'num') + td(fmt(r.failures), 'num') + '</tr>';
    }));
    $('#calls').innerHTML = table(['זמן', 'טלפון', 'תורות', 'בקשות', 'כלים', 'קלט', 'פלט', 'עלות', 'מודלים', 'סיום'], (u.calls || []).map(function (c) {
      var tk = c.tokens || {};
      return '<tr class="clickable" data-call="' + esc(c.callId) + '" tabindex="0" title="הצג תמליל">' +
        td(esc(when(c.startedAt))) +
        td(esc(dash(c.phone)), 'ltr') +
        td(fmt(c.turns), 'num') +
        td(fmt(c.llmRequests), 'num') +
        td(fmt(c.toolCalls), 'num') +
        td(fmt(tk.inputTokens), 'num') +
        td(fmt(tk.outputTokens), 'num') +
        td(money(c.costUsd), 'num') +
        td(esc((c.models || []).join(', ')), 'ltr') +
        td(esc(dash(c.endedBy))) +
        '</tr>';
    }));
  }

  function renderEvents(events) {
    if (!events.length) return '<div class="empty">אין אירועים לשיחה הזו.</div>';
    var sorted = events.slice().sort(function (a, b) { return (a.ts || '') < (b.ts || '') ? -1 : (a.ts || '') > (b.ts || '') ? 1 : 0; });
    return sorted.map(function (e) {
      if (e.kind === 'turn') {
        return '<div class="ev turn-user"><div class="t">תור ' + fmt(e.turn) + ' · ' + esc(when(e.ts)) + ' · מתקשר</div>' + esc(e.userText || '(שקט)') + '</div>' +
          '<div class="ev turn-bot"><div class="t">עוזר · ' + fmt(e.durationMs) + ' ms</div>' + esc(e.assistantText || '') + '</div>';
      }
      if (e.kind === 'tool') {
        var b = e.blocked ? '<span class="badge warn">נחסם</span>' : (e.ok ? '<span class="badge ok">הצליח</span>' : '<span class="badge err">נכשל</span>');
        return '<div class="ev tool">כלי <code>' + esc(e.tool) + '</code> ' + b + ' · ' + fmt(e.durationMs) + ' ms' + (e.server && e.server !== '?' ? ' · שרת ' + esc(e.server) : '') + '</div>';
      }
      if (e.kind === 'llm') {
        var model = e.servedModel || e.requestedModel || '?';
        var fb = e.servedModel && e.requestedModel && e.servedModel !== e.requestedModel ? ' (התבקש ' + esc(e.requestedModel) + ')' : '';
        return '<div class="ev llm">מודל <code>' + esc(model) + '</code>' + fb +
          ' · מאמץ ' + esc(dash(e.effort)) +
          ' · קלט ' + fmt(e.inputTokens) + ' · פלט ' + fmt(e.outputTokens) +
          ' · קאש קריאה ' + fmt(e.cacheReadTokens) + ' / כתיבה ' + fmt(e.cacheWriteTokens) +
          ' · ' + money(e.costUsd) +
          ' · סיום: <code>' + esc(dash(e.stopReason)) + '</code>' +
          ' · ' + fmt(e.durationMs) + ' ms</div>';
      }
      if (e.kind === 'call') {
        return '<div class="ev call">שיחה מ-<span class="ltr">' + esc(dash(e.phone)) + '</span> · התחילה ' + esc(when(e.startedAt)) + ' · הסתיימה ' + esc(when(e.endedAt)) + ' · ' + fmt(e.turns) + ' תורות · סיום: ' + esc(dash(e.endedBy)) + '</div>';
      }
      return '<div class="ev">' + esc(JSON.stringify(e)) + '</div>';
    }).join('');
  }

  async function openCall(id) {
    $('#modal-title').textContent = 'שיחה ' + id;
    $('#modal-body').innerHTML = '<div class="empty">טוען...</div>';
    $('#call-modal').hidden = false;
    try {
      var r = await api('GET', '/admin/api/calls/' + encodeURIComponent(id));
      $('#modal-body').innerHTML = renderEvents((r && r.events) || []);
    } catch (e) {
      $('#modal-body').innerHTML = '<div class="empty">טעינת השיחה נכשלה: ' + esc(e.message) + '</div>';
    }
  }

  function closeModal() { $('#call-modal').hidden = true; }

  /* ------------------------------ chat ------------------------------ */

  function addMsg(role, text, meta) {
    var log = $('#chat-log');
    var el = document.createElement('div');
    el.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
    var html = esc(text);
    if (meta) {
      var bits = [];
      if (meta.toolCalls && meta.toolCalls.length) bits.push('כלים: ' + esc(meta.toolCalls.join(', ')));
      if (typeof meta.iterations === 'number') bits.push('סבבים: ' + fmt(meta.iterations));
      if (typeof meta.durationMs === 'number') bits.push(fmt(meta.durationMs) + ' ms');
      if (bits.length) html += '<div class="meta">' + bits.join(' · ') + '</div>';
      if (meta.error) html += '<div class="err">שגיאה: ' + esc(meta.error) + '</div>';
    }
    el.innerHTML = html;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }

  function setChatBusy(busy) {
    $('#btn-send').disabled = busy;
    $('#btn-new-chat').disabled = busy;
  }

  async function sendChat(e) {
    e.preventDefault();
    var input = $('#chat-input');
    var text = input.value.trim();
    if (!text) return;
    addMsg('user', text);
    input.value = '';
    var pending = addMsg('bot', 'חושב...');
    setChatBusy(true);
    try {
      var body = { message: text };
      if (chatSessionId) body.sessionId = chatSessionId;
      var r = await api('POST', '/admin/api/chat', body);
      r = r || {};
      chatSessionId = r.sessionId || chatSessionId;
      if (pending.parentNode) pending.parentNode.removeChild(pending);
      addMsg('bot', r.text || '(ללא תשובה)', r);
      if (r.endCall) {
        chatSessionId = null;
        toast('העוזר סיים את השיחה – ההודעה הבאה תפתח שיחה חדשה');
      }
    } catch (err) {
      if (pending.parentNode) pending.parentNode.removeChild(pending);
      addMsg('bot', '', { error: err.message });
    } finally {
      setChatBusy(false);
      input.focus();
    }
  }

  async function newChat() {
    $('#chat-log').innerHTML = '';
    if (chatSessionId) {
      try {
        await api('POST', '/admin/api/chat', { message: '', sessionId: chatSessionId, reset: true });
      } catch (e) {
        chatSessionId = null;
      }
    }
    toast('התחילה שיחה חדשה');
    $('#chat-input').focus();
  }

  /* ------------------------------ rules and instructions ------------------------------ */

  var rulesLoaded = false;

  function renderRules(rules) {
    var box = $('#rules-list');
    if (!rules.length) { box.innerHTML = '<div class="empty">עדיין אין כללים קבועים.</div>'; return; }
    box.innerHTML = rules.map(function (r) {
      return '<div class="rule" data-rule="' + esc(r.id) + '">' +
        '<label for="rule-' + esc(r.id) + '" class="sr-only">כלל ' + esc(r.id) + '</label>' +
        '<textarea id="rule-' + esc(r.id) + '" rows="2" maxlength="600">' + esc(r.text) + '</textarea>' +
        '<div class="row"><span class="meta">#' + esc(r.id) + ' · מקור: ' + esc(dash(r.source)) + ' · עודכן ' + esc(when(r.updatedAt)) + '</span>' +
        '<span style="flex:1"></span>' +
        '<button type="button" class="btn small" data-act="update" data-id="' + esc(r.id) + '">עדכן</button>' +
        '<button type="button" class="btn small" data-act="delete" data-id="' + esc(r.id) + '">מחק</button></div>' +
        '</div>';
    }).join('');
  }

  async function loadRules() {
    try {
      var r = await api('GET', '/admin/api/rules');
      renderRules((r && r.rules) || []);
      rulesLoaded = true;
    } catch (e) {
      toast('טעינת הכללים נכשלה: ' + e.message, 'err');
    }
  }

  async function addRule(e) {
    e.preventDefault();
    var ta = $('#rule-new');
    var text = ta.value.trim();
    if (!text) { toast('כתבו את הכלל קודם', 'err'); return; }
    var btn = $('#btn-rule-add');
    btn.disabled = true;
    try {
      var r = await api('POST', '/admin/api/rules', { text: text });
      ta.value = '';
      renderRules((r && r.rules) || []);
      toast('הכלל נוסף', 'ok');
      promptLoaded = false;
    } catch (err) {
      toast('הוספת הכלל נכשלה: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  async function ruleAction(e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var id = btn.getAttribute('data-id');
    var act = btn.getAttribute('data-act');
    var wrap = btn.closest('.rule');
    var ta = wrap ? wrap.querySelector('textarea') : null;
    if (act === 'delete' && !window.confirm('למחוק את הכלל #' + id + '?')) return;
    btn.disabled = true;
    try {
      var r;
      if (act === 'update') {
        var text = ta ? ta.value.trim() : '';
        if (!text) throw new Error('הכלל לא יכול להיות ריק');
        r = await api('PUT', '/admin/api/rules/' + encodeURIComponent(id), { text: text });
        toast('הכלל עודכן', 'ok');
      } else if (act === 'delete') {
        r = await api('DELETE', '/admin/api/rules/' + encodeURIComponent(id));
        toast('הכלל נמחק', 'ok');
      } else {
        return;
      }
      renderRules((r && r.rules) || []);
      promptLoaded = false;
    } catch (err) {
      toast('הפעולה נכשלה: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  async function loadInstructions() {
    try {
      var t = await api('GET', '/admin/api/instructions');
      if (typeof t !== 'string') t = '';
      $('#instr-text').value = t;
      $('#instr-chars').textContent = fmt(t.length);
    } catch (e) {
      toast('טעינת ההוראות נכשלה: ' + e.message, 'err');
    }
  }

  async function saveInstructions() {
    var btn = $('#btn-instr-save');
    btn.disabled = true;
    try {
      var text = $('#instr-text').value;
      await api('PUT', '/admin/api/instructions', { text: text });
      $('#instr-chars').textContent = fmt(text.length);
      toast('ההוראות נשמרו והפרומפט רוענן', 'ok');
      promptLoaded = false;
    } catch (e) {
      toast('שמירת ההוראות נכשלה: ' + e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  /* ------------------------------ proactive routines ------------------------------ */

  var routinesLoaded = false;
  var routinesCache = [];
  var CHANNEL_LABEL = { log: 'יומן בלבד', whatsapp: 'וואטסאפ', sms: 'SMS', email: 'אימייל' };
  var ROUTINE_EXAMPLES = [
    { name: 'תדריך בוקר', kind: 'cron', cron: '0 8 * * 0-4', prompt: 'הכן תדריך בוקר קצר: הפגישות והאירועים של היום ביומן, לידים חדשים מאתמול, פניות שלא נענו, ותשלומים שהיו אמורים להתקבל ולא התקבלו. שלח את התדריך תמיד (גם אם יום רגוע - כתוב זאת במשפט), עם עד חמש נקודות והצעה מה לעשות קודם.' },
    { name: 'לידים ללא מענה', kind: 'cron', cron: '0 9-18 * * 0-4', prompt: 'בדוק ב-CRM אילו פניות נכנסות (לידים) לא קיבלו מענה מעל 3 שעות. אם יש כאלה, שלח לי רשימה קצרה: שם, טלפון, מה ביקשו וכמה זמן ממתינים, והצע למי לחזור קודם. אם אין - אל תשלח כלום.' },
    { name: 'חובות פתוחים', kind: 'cron', cron: '0 10 * * 1', prompt: 'בדוק אילו לקוחות חייבים כסף (חשבוניות או תשלומים שעבר תאריך היעד שלהם) ב-CRM ובסאמיט. שלח לי סיכום עם שם, סכום, כמה ימים באיחור, והצע לאילו לקוחות כדאי לשלוח תזכורת תשלום. אם אין חובות - אל תשלח.' },
    { name: 'סיכום שבועי', kind: 'cron', cron: '0 12 * * 5', prompt: 'הכן סיכום שבועי: כמה לידים חדשים נכנסו השבוע, כמה הפכו ללקוחות, הכנסות שנרשמו, פגישות שהתקיימו, ומה נשאר פתוח לשבוע הבא. שלח תמיד, בעד שש שורות.' },
    { name: 'ליד חדש - בדיקה מיידית', kind: 'event', events: 'new_lead', prompt: 'התקבל ליד חדש (הפרטים בנתוני האירוע). בדוק ב-CRM אם זה לקוח קיים או כפילות, מה מקור הפנייה ומה ביקש, ושלח לי הודעה קצרה עם הפרטים והצעה איך ומתי לחזור אליו.' },
    { name: 'תור ימות המשיח', kind: 'interval', every: 30, prompt: 'בדוק בימות המשיח אם יש הודעות קוליות חדשות או שיחות שלא נענו בשעה האחרונה. אם יש, שלח לי מי התקשר ומתי והצע למי לחזור. אם אין - אל תשלח.' }
  ];

  function describeSchedule(sch) {
    if (!sch) return '–';
    if (sch.kind === 'cron') return 'לפי לוח זמנים · ' + sch.expression;
    if (sch.kind === 'interval') return 'כל ' + fmt(sch.everyMinutes) + ' דקות';
    if (sch.kind === 'event') return 'באירוע: ' + (sch.eventTypes || []).join(', ');
    return 'ידני בלבד';
  }

  function renderRoutines(list) {
    routinesCache = list || [];
    var box = $('#routines-list');
    var enabledCount = routinesCache.filter(function (r) { return r.enabled; }).length;
    $('#routines-status').textContent = routinesCache.length ? (fmt(enabledCount) + ' פעילות מתוך ' + fmt(routinesCache.length)) : 'אין משימות';
    if (!routinesCache.length) { box.innerHTML = '<div class="empty">עדיין אין משימות יזומות. צרו אחת בטופס למטה או בחרו דוגמה מוכנה.</div>'; return; }
    box.innerHTML = routinesCache.map(function (r) {
      var last = r.lastResult;
      var lastHtml = last
        ? '<div class="meta">הרצה אחרונה ' + esc(when(last.at)) + ' (' + esc(last.trigger) + ', ' + fmt(Math.round((last.durationMs || 0) / 1000)) + ' שנ\', ' + fmt((last.toolCalls || []).length) + ' כלים) · ' +
          (last.ok ? '<span class="badge ok">הסתיימה</span>' : '<span class="badge err">שגיאה</span>') + ' ' +
          (last.notified ? '<span class="badge info">נשלחה הודעה</span>' : '<span class="badge">ללא הודעה</span>') +
          (last.error ? '<div class="meta" dir="auto">' + esc(last.error) + '</div>' : '') +
          (last.text ? '<div class="meta" dir="auto" style="white-space:pre-wrap">' + esc(String(last.text).slice(0, 400)) + (String(last.text).length > 400 ? '…' : '') + '</div>' : '') + '</div>'
        : '<div class="meta">עדיין לא רצה.</div>';
      return '<div class="rule" data-routine="' + esc(r.id) + '">' +
        '<div class="row"><b>' + esc(r.name) + '</b> ' +
        (r.enabled ? '<span class="badge ok">פעילה</span>' : '<span class="badge warn">כבויה</span>') +
        (r.running ? ' <span class="badge info">רצה עכשיו...</span>' : '') +
        '<span style="flex:1"></span><span class="meta">' + esc(r.id) + ' · מקור: ' + esc(dash(r.source)) + '</span></div>' +
        '<div class="meta">' + esc(describeSchedule(r.schedule)) + ' · הודעה: ' + esc(CHANNEL_LABEL[r.channel] || r.channel) +
        (r.nextRunAt ? ' · הריצה הבאה: ' + esc(when(r.nextRunAt)) : '') +
        (r.quietHours ? ' · שקט ' + esc(r.quietHours.from) + '–' + esc(r.quietHours.to) : '') + '</div>' +
        '<div dir="auto" style="white-space:pre-wrap;font-size:14px">' + esc(r.prompt) + '</div>' +
        lastHtml +
        '<div class="row">' +
        '<button type="button" class="btn small primary" data-act="run" data-id="' + esc(r.id) + '">הרץ עכשיו</button>' +
        '<button type="button" class="btn small" data-act="edit" data-id="' + esc(r.id) + '">ערוך</button>' +
        '<button type="button" class="btn small" data-act="toggle" data-id="' + esc(r.id) + '">' + (r.enabled ? 'כבה' : 'הפעל') + '</button>' +
        '<button type="button" class="btn small" data-act="runs" data-id="' + esc(r.id) + '">יומן הרצות</button>' +
        '<button type="button" class="btn small" data-act="delete" data-id="' + esc(r.id) + '">מחק</button>' +
        '</div></div>';
    }).join('');
  }

  function renderNotifications(list) {
    var box = $('#notifications');
    if (!list || !list.length) { box.innerHTML = '<div class="empty">עדיין לא נשלחו הודעות.</div>'; return; }
    box.innerHTML = '<table><thead><tr><th>מתי</th><th>ערוץ</th><th>מצב</th><th>הודעה</th><th>פרטים</th></tr></thead><tbody>' + list.map(function (n) {
      return '<tr><td>' + esc(when(n.ts)) + '</td><td>' + esc(CHANNEL_LABEL[n.channel] || n.channel) + '</td><td>' +
        (n.ok ? '<span class="badge ok">נשלח</span>' : '<span class="badge err">נכשל</span>') + '</td><td dir="auto" style="white-space:pre-wrap;max-width:420px">' + esc(n.text) + '</td><td dir="auto" class="meta">' + esc(n.detail) + '</td></tr>';
    }).join('') + '</tbody></table>';
  }

  async function loadRoutines() {
    try {
      var r = await api('GET', '/admin/api/routines');
      renderRoutines((r && r.routines) || []);
      renderNotifications((r && r.notifications) || []);
      if (r && r.enabled === false) toast('שימו לב: המשימות היזומות כבויות בהגדרות (רק הרצה ידנית תעבוד)');
      routinesLoaded = true;
    } catch (e) {
      toast('טעינת המשימות נכשלה: ' + e.message, 'err');
    }
  }

  function routineKindChanged() {
    var kind = $('#rt-kind').value;
    $$('#routine-form [data-kind]').forEach(function (el) { el.hidden = el.getAttribute('data-kind') !== kind; });
  }

  function routinePresetChanged() {
    var v = $('#rt-preset').value;
    if (v !== 'custom') $('#rt-cron').value = v;
  }

  function syncPresetFromCron() {
    var v = $('#rt-cron').value.trim();
    var sel = $('#rt-preset');
    var found = false;
    $$('option', sel).forEach(function (o) { if (o.value === v) found = true; });
    sel.value = found ? v : 'custom';
  }

  function fillRoutineForm(r) {
    $('#rt-id').value = r ? r.id : '';
    $('#routine-form-title').textContent = r ? 'עריכת משימה: ' + r.name : 'משימה חדשה';
    $('#btn-rt-cancel').hidden = !r;
    $('#btn-rt-save').textContent = r ? 'שמור שינויים' : 'שמור משימה';
    $('#rt-name').value = r ? r.name : '';
    $('#rt-channel').value = r ? r.channel : ((state && state.settings && state.settings.notifyChannel) || 'log');
    var sch = r ? r.schedule : { kind: 'cron', expression: '0 8 * * *' };
    $('#rt-kind').value = sch.kind;
    $('#rt-cron').value = sch.kind === 'cron' ? sch.expression : '0 8 * * *';
    $('#rt-every').value = sch.kind === 'interval' ? sch.everyMinutes : 60;
    $('#rt-events').value = sch.kind === 'event' ? (sch.eventTypes || []).join(', ') : '';
    $('#rt-prompt').value = r ? r.prompt : '';
    $('#rt-quiet').checked = !!(r && r.quietHours);
    $('#rt-quiet-row').hidden = !(r && r.quietHours);
    $('#rt-quiet-from').value = hhmm(r && r.quietHours ? r.quietHours.from : '22:00');
    $('#rt-quiet-to').value = hhmm(r && r.quietHours ? r.quietHours.to : '07:00');
    syncPresetFromCron();
    routineKindChanged();
  }

  function applyRoutineExample() {
    var idx = Number($('#rt-example').value);
    var ex = ROUTINE_EXAMPLES[idx];
    $('#rt-example').value = '';
    if (!ex) return;
    fillRoutineForm(null);
    $('#rt-name').value = ex.name;
    $('#rt-kind').value = ex.kind;
    if (ex.cron) $('#rt-cron').value = ex.cron;
    if (ex.every) $('#rt-every').value = ex.every;
    if (ex.events) $('#rt-events').value = ex.events;
    $('#rt-prompt').value = ex.prompt;
    syncPresetFromCron();
    routineKindChanged();
    $('#rt-name').focus();
  }

  function collectRoutine() {
    var kind = $('#rt-kind').value;
    var schedule;
    if (kind === 'cron') {
      var expr = $('#rt-cron').value.trim();
      if (expr.split(/\s+/).length !== 5) throw new Error('ביטוי cron חייב להכיל 5 שדות');
      schedule = { kind: 'cron', expression: expr };
    } else if (kind === 'interval') {
      var every = Number($('#rt-every').value);
      if (!isFinite(every) || every < 5 || every > 10080) throw new Error('המרווח חייב להיות בין 5 ל-10080 דקות');
      schedule = { kind: 'interval', everyMinutes: Math.floor(every) };
    } else if (kind === 'event') {
      var types = $('#rt-events').value.split(',').map(function (t) { return t.trim(); }).filter(Boolean);
      if (!types.length) throw new Error('יש להזין לפחות סוג אירוע אחד');
      schedule = { kind: 'event', eventTypes: types };
    } else {
      schedule = { kind: 'manual' };
    }
    var name = $('#rt-name').value.trim();
    var prompt = $('#rt-prompt').value.trim();
    if (!name) throw new Error('יש להזין שם למשימה');
    if (prompt.length < 3) throw new Error('יש לכתוב הנחיה');
    var quiet = null;
    if ($('#rt-quiet').checked) {
      var qf = $('#rt-quiet-from').value, qt = $('#rt-quiet-to').value;
      if (!/^\d{1,2}:\d{2}$/.test(qf) || !/^\d{1,2}:\d{2}$/.test(qt)) throw new Error('שעות שקט: יש להזין שעה בפורמט HH:MM');
      quiet = { from: qf, to: qt };
    }
    return { name: name, schedule: schedule, prompt: prompt, channel: $('#rt-channel').value, quietHours: quiet };
  }

  async function saveRoutine(e) {
    e.preventDefault();
    var input;
    try { input = collectRoutine(); } catch (err) { toast(err.message, 'err'); return; }
    var id = $('#rt-id').value;
    var btn = $('#btn-rt-save');
    btn.disabled = true;
    try {
      var r = id ? await api('PUT', '/admin/api/routines/' + encodeURIComponent(id), input) : await api('POST', '/admin/api/routines', input);
      renderRoutines((r && r.routines) || []);
      fillRoutineForm(null);
      toast(id ? 'המשימה עודכנה' : 'המשימה נוצרה', 'ok');
    } catch (err) {
      toast('השמירה נכשלה: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  async function routineAction(e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var id = btn.getAttribute('data-id');
    var act = btn.getAttribute('data-act');
    var routine = routinesCache.filter(function (r) { return r.id === id; })[0];
    if (!routine) return;
    if (act === 'edit') { fillRoutineForm(routine); $('#rt-name').scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    if (act === 'runs') { openRoutineRuns(routine); return; }
    if (act === 'delete' && !window.confirm('למחוק את המשימה "' + routine.name + '"?')) return;
    btn.disabled = true;
    try {
      var r;
      if (act === 'run') {
        btn.textContent = 'רצה...';
        toast('המשימה "' + routine.name + '" רצה עכשיו – זה יכול לקחת דקה או שתיים');
        r = await api('POST', '/admin/api/routines/' + encodeURIComponent(id) + '/run', {});
        var res = (r && r.result) || {};
        if (res.ok) toast(res.notified ? 'הסתיימה ונשלחה הודעה לבעל העסק' : 'הסתיימה – לא היה מה לדווח', 'ok');
        else toast('ההרצה נכשלה: ' + (res.error || ''), 'err');
        loadRoutines();
        return;
      } else if (act === 'toggle') {
        r = await api('PUT', '/admin/api/routines/' + encodeURIComponent(id), { enabled: !routine.enabled });
        toast(routine.enabled ? 'המשימה כובתה' : 'המשימה הופעלה', 'ok');
      } else if (act === 'delete') {
        r = await api('DELETE', '/admin/api/routines/' + encodeURIComponent(id));
        toast('המשימה נמחקה', 'ok');
        if ($('#rt-id').value === id) fillRoutineForm(null);
      } else {
        return;
      }
      renderRoutines((r && r.routines) || []);
    } catch (err) {
      toast('הפעולה נכשלה: ' + err.message, 'err');
      loadRoutines();
    } finally {
      btn.disabled = false;
    }
  }

  async function openRoutineRuns(routine) {
    $('#modal-title').textContent = 'יומן הרצות: ' + routine.name;
    $('#modal-body').innerHTML = '<div class="empty">טוען...</div>';
    $('#call-modal').hidden = false;
    try {
      var r = await api('GET', '/admin/api/routines/' + encodeURIComponent(routine.id) + '/runs');
      var runs = (r && r.runs) || [];
      if (!runs.length) { $('#modal-body').innerHTML = '<div class="empty">עדיין אין הרצות.</div>'; return; }
      $('#modal-body').innerHTML = runs.map(function (run) {
        return '<div class="rule"><div class="row"><b>' + esc(when(run.ts)) + '</b> <span class="meta">' + esc(run.trigger) + ' · ' + fmt(Math.round((run.durationMs || 0) / 1000)) + ' שנ\'</span><span style="flex:1"></span>' +
          (run.ok ? '<span class="badge ok">הסתיימה</span>' : '<span class="badge err">שגיאה</span>') + ' ' + (run.notified ? '<span class="badge info">נשלחה הודעה</span>' : '') + '</div>' +
          (run.error ? '<div class="meta" dir="auto">' + esc(run.error) + '</div>' : '') +
          '<div dir="auto" style="white-space:pre-wrap;font-size:14px">' + esc(run.text || '') + '</div>' +
          '<div class="row"><button type="button" class="btn small" data-call-open="' + esc(run.callId) + '">התמליל המלא</button></div></div>';
      }).join('');
    } catch (e) {
      $('#modal-body').innerHTML = '<div class="empty">טעינת היומן נכשלה: ' + esc(e.message) + '</div>';
    }
  }

  /* ------------------------------ prompt ------------------------------ */

  async function loadPrompt() {
    var pre = $('#prompt-text');
    try {
      var t = await api('GET', '/admin/api/prompt');
      if (typeof t !== 'string') t = JSON.stringify(t, null, 2);
      pre.textContent = t;
      $('#prompt-chars').textContent = fmt(t.length);
      promptLoaded = true;
    } catch (e) {
      pre.textContent = '';
      toast('טעינת הפרומפט נכשלה: ' + e.message, 'err');
    }
  }

  /* ------------------------------ init ------------------------------ */

  function init() {
    $$('nav.tabs button').forEach(function (b) {
      b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
    });
    $('#btn-refresh').addEventListener('click', function () {
      loadState(false);
      if (usageLoaded) loadUsage();
    });
    $('#settings-form').addEventListener('submit', function (e) { e.preventDefault(); saveSettings(); });
    $('#f-model').addEventListener('change', modelHint);
    $('#btn-clear-pin').addEventListener('click', clearPin);
    $('#btn-copy').addEventListener('click', copyWebhook);
    $('#servers').addEventListener('click', serverAction);
    $$('#usage-ranges button').forEach(function (b) {
      b.addEventListener('click', function () { usageRange = b.getAttribute('data-range') || 'all'; loadUsage(); });
    });
    function callFromEvent(e) {
      var row = e.target.closest ? e.target.closest('tr[data-call]') : null;
      if (row) openCall(row.getAttribute('data-call'));
    }
    $('#calls').addEventListener('click', callFromEvent);
    $('#calls').addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); callFromEvent(e); } });
    $('#chat-form').addEventListener('submit', sendChat);
    $('#btn-new-chat').addEventListener('click', newChat);
    $('#btn-prompt-reload').addEventListener('click', loadPrompt);
    $('#rule-add-form').addEventListener('submit', addRule);
    $('#rules-list').addEventListener('click', ruleAction);
    $('#btn-instr-save').addEventListener('click', saveInstructions);
    $('#btn-instr-reload').addEventListener('click', loadInstructions);
    $('#btn-notify-test').addEventListener('click', notifyTest);
    $('#btn-routines-reload').addEventListener('click', loadRoutines);
    $('#routines-list').addEventListener('click', routineAction);
    $('#routine-form').addEventListener('submit', saveRoutine);
    $('#btn-rt-cancel').addEventListener('click', function () { fillRoutineForm(null); });
    $('#rt-kind').addEventListener('change', routineKindChanged);
    $('#rt-preset').addEventListener('change', routinePresetChanged);
    $('#rt-cron').addEventListener('input', syncPresetFromCron);
    $('#rt-quiet').addEventListener('change', function () { $('#rt-quiet-row').hidden = !$('#rt-quiet').checked; });
    var exSel = $('#rt-example');
    ROUTINE_EXAMPLES.forEach(function (ex, i) { var o = document.createElement('option'); o.value = String(i); o.textContent = ex.name; exSel.appendChild(o); });
    exSel.addEventListener('change', applyRoutineExample);
    $('#modal-body').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-call-open]') : null;
      if (b) openCall(b.getAttribute('data-call-open'));
    });
    $('#modal-close').addEventListener('click', closeModal);
    $('#call-modal').addEventListener('click', function (e) { if (e.target === e.currentTarget) closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });
    window.addEventListener('hashchange', function () {
      var h = location.hash.replace('#', '');
      if (h) showTab(h);
    });

    var tab = (location.hash || '').replace('#', '') || 'settings';
    var params = new URLSearchParams(location.search);
    var login = params.get('login');
    if (login) {
      if (login === 'ok') toast('ההתחברות הצליחה', 'ok');
      else toast('ההתחברות נכשלה: ' + (params.get('message') || 'שגיאה לא ידועה'), 'err');
      tab = 'connections';
      try { history.replaceState(null, '', location.pathname + '#connections'); } catch (e) { /* ignore */ }
    }
    showTab(tab);
    loadState(true);

    // Keep the header and the connections view fresh without touching the settings form.
    setInterval(function () {
      if (document.visibilityState === 'visible' && state) loadState(false);
    }, 30000);
  }

  init();
})();
`;

/** Renders the complete admin page (Hebrew, RTL, self-contained). */
export function renderAdminPage(): string {
  return [
    "<!doctype html>",
    '<html lang="he" dir="rtl">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    "<title>MAINBOT - ניהול</title>",
    "<style>" + CSS + "</style>",
    "</head>",
    "<body>",
    BODY,
    "<script>" + SCRIPT + "</script>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
