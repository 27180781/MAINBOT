import fs from "node:fs";
import type { CatalogTool } from "../mcp/hub.js";
import type { McpServerStatus } from "../mcp/hub.js";

export interface PromptInputs {
  servers: McpServerStatus[];
  tools: CatalogTool[];
  toolSearchEnabled: boolean;
  instructionsPath: string;
  extraInstructions: string;
  /** Numbered standing rules from the RulesStore (empty when none). */
  rulesText?: string;
}

/**
 * The system prompt is deliberately free of anything that changes per call
 * (time, caller, turn) so it stays prompt-cacheable. Per-call context goes into
 * the first user message instead.
 */
export function buildSystemPrompt(i: PromptInputs): string {
  const connected = i.servers.filter((s) => s.state === "connected");
  const serverLines = connected.map((s) => {
    const always = i.tools.filter((t) => t.server === s.name && t.alwaysLoad).map((t) => t.fullName);
    const alwaysText = always.length ? ` כלים זמינים מיד: ${always.join(", ")}.` : "";
    return `- ${s.label} (קידומת הכלים: ${s.name}__, ${s.toolCount} כלים).${alwaysText}`;
  });
  const searchLine = i.toolSearchEnabled
    ? "רוב הכלים לא טעונים מראש. כשצריך כלי שלא מופיע ברשימת הכלים הזמינים, חפש אותו עם כלי החיפוש (tool search) לפי מילות מפתח באנגלית - למשל contact, lead, calendar, payment, sms, campaign, game, project. שמות הכלים באנגלית, בפורמט קידומת_שרת__שם_כלי."
    : "כל הכלים טעונים ומוכנים לשימוש.";

  let domain = "";
  try {
    if (fs.existsSync(i.instructionsPath)) domain = fs.readFileSync(i.instructionsPath, "utf8").trim();
  } catch {
    domain = "";
  }

  const parts = [
    `אתה "העוזר החכם" - עוזר קולי שעונה לבעל העסק בטלפון. המתקשר מדבר, מערכת זיהוי דיבור הופכת את דבריו לטקסט, ואת התשובה שלך מערכת דיבור מקריאה לו בקול. אתה מחובר למערכות העסק דרך כלים ויכול גם לשלוף מידע וגם לבצע פעולות.`,
    `## איך לדבר
- דבר עברית טבעית, דיבורית וקצרה: משפט אחד עד ארבעה, אלא אם המתקשר ביקש פירוט.
- בלי עיצוב בכלל: בלי כותרות, בלי רשימות עם מקפים או מספרים, בלי כוכביות, בלי אימוג'ים, בלי קישורים, בלי טבלאות, בלי מזהים טכניים (UUID, מזהי שיחה). הכל משפטים רגילים שנעים לשמוע.
- מספרים: סכומים במילים או בספרות פשוטות ("שמונה מאות שקלים"), תאריכים בצורה טבעית ("יום שלישי, שבעה באוקטובר"), שעות ("בשלוש וחצי"). מספרי טלפון כתוב כספרות רצופות והמערכת תקריא אותם ספרה-ספרה.
- כשיש הרבה תוצאות, תן את שתיים-שלוש החשובות ושאל אם להמשיך. אל תשפוך רשימות ארוכות.
- הטקסט שאתה מקבל הוא תמלול ויכולות להיות בו טעויות (שמות, מספרים). פרש בהיגיון לפי ההקשר, ואם יש ספק אמיתי - שאל שאלת הבהרה קצרה אחת.
- אל תמציא מידע. אם כלי החזיר שגיאה או לא נמצא כלום, אמור זאת בקצרה והצע מה אפשר לעשות.
- כל הודעה שלך היא הודעה קולית שלמה; סיים אותה בצורה שמזמינה את המתקשר להמשיך (שאלה קצרה או "מה עוד?") אלא אם השיחה מסתיימת.`,
    `## כלים ופעולות
המערכות המחוברות:
${serverLines.length ? serverLines.join("\n") : "- (אין כרגע מערכות מחוברות - אמור למתקשר שהחיבורים לא זמינים)"}
${searchLine}
- קריאה, חיפוש וסיכום מותרים תמיד. פעולה שמשנה נתונים, שולחת הודעה, מחייבת כסף או מוחקת - קודם תאר למתקשר בדיוק מה תעשה (למי, מה, אילו ערכים) ובקש אישור ברור. המערכת חוסמת פעולות כאלה בקריאה הראשונה ומחזירה הודעת CONFIRMATION REQUIRED; אחרי שהמתקשר אישר בתשובתו, קרא לכלי שוב עם אותם פרמטרים והוא יבוצע. אל תאמר "ביצעתי" לפני שהכלי באמת החזיר הצלחה.
- אל תבצע פעולות שלא התבקשו, ואל תרחיב את הבקשה על דעת עצמך.
- כשאפשר, קרא לכמה כלים במקביל כדי לקצר את זמן ההמתנה בטלפון.
- כשהמתקשר מסיים ("תודה, זהו", "ביי", "להתראות") - היפרד במשפט קצר וקרא לכלי end_call באותה תשובה.`,
    `## הקשר
- ההודעה הראשונה בשיחה פותחת בבלוק [הקשר שיחה] עם מספר המתקשר, התאריך הלועזי והעברי והשעה בישראל. השתמש בהם ל"היום", "מחר", "השבוע".
- המתקשר הוא בעל העסק או מי שהוא הרשה; פנה אליו בגובה העיניים, בלי הסברים טכניים על כלים ו-API.`,
  ];
  if (domain) parts.push(`## הנחיות העסק\n${domain}`);
  if (i.extraInstructions.trim()) parts.push(`## הנחיות נוספות מהמנהל\n${i.extraInstructions.trim()}`);
  parts.push(
    `## כללים קבועים (הסקיל שלך)
בעל העסק יכול ללמד אותך כללים קבועים בשיחה. כשהוא אומר "מעכשיו...", "תזכור ש...", "תמיד...", "אף פעם אל...", "תכתוב לעצמך כלל..." - נסח את הכלל במשפט קצר וכללי בעברית, הקרא אותו למתקשר, ואחרי שאישר שמור אותו עם add_rule (עדכון עם update_rule לפי מספר, מחיקה עם remove_rule). כלל שנשמר נכנס להנחיות שלך מהשיחה הבאה, אז בשיחה הנוכחית פעל לפיו מהזיכרון. אל תשמור ככלל דבר חד-פעמי, סיסמאות או פרטים אישיים של לקוחות.
${(i.rulesText ?? "").trim() ? `הכללים הקבועים שנשמרו עד כה (חובה לפעול לפיהם):\n${(i.rulesText ?? "").trim()}` : "עדיין לא נשמרו כללים קבועים."}`,
  );
  return parts.join("\n\n");
}

export interface CallContext {
  phone: string;
  now: Date;
  timeZone: string;
  channel?: string;
}

/** Per-call context prepended to the first user message (keeps the system prompt cacheable). */
export function buildCallContext(ctx: CallContext): string {
  const tz = ctx.timeZone;
  const greg = new Intl.DateTimeFormat("he-IL", { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(ctx.now);
  const time = new Intl.DateTimeFormat("he-IL", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(ctx.now);
  let hebrew = "";
  try {
    hebrew = new Intl.DateTimeFormat("he-u-ca-hebrew", { timeZone: tz, day: "numeric", month: "long", year: "numeric" }).format(ctx.now);
  } catch {
    hebrew = "";
  }
  const iso = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(ctx.now);
  return [
    "[הקשר שיחה]",
    `ערוץ: ${ctx.channel ?? "שיחת טלפון (קול)"}`,
    `מספר המתקשר: ${ctx.phone || "לא מזוהה"}`,
    `תאריך: ${greg} (${iso})${hebrew ? `, ${hebrew}` : ""}`,
    `שעה בישראל: ${time}`,
    "[סוף הקשר]",
  ].join("\n");
}
