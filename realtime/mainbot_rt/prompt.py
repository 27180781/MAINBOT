"""The Hebrew system prompt for the realtime voice channel.

Kept close to src/agent/prompt.ts (the phone/PBX prompt) so both agents behave the
same, with the differences a streaming, interruptible conversation needs.
"""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from .node_bridge import AgentConfig, McpServerInfo

HEBREW_WEEKDAYS = ["שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת", "ראשון"]


def call_context(*, phone: str, timezone: str, channel: str) -> str:
    now = datetime.now(ZoneInfo(timezone))
    weekday = HEBREW_WEEKDAYS[now.weekday()]
    return "\n".join(
        [
            "[הקשר שיחה]",
            f"ערוץ: {channel}",
            f"מספר המתקשר: {phone or 'לא מזוהה'}",
            f"תאריך: יום {weekday}, {now.strftime('%d.%m.%Y')}",
            f"שעה בישראל: {now.strftime('%H:%M')}",
            "[סוף הקשר]",
        ]
    )


def build_instructions(config: AgentConfig | None, servers: list[McpServerInfo], *, context: str) -> str:
    server_lines = []
    for s in servers:
        always = f" כלים זמינים מיד: {', '.join(s.always_load)}." if s.always_load else ""
        server_lines.append(f"- {s.label} (קידומת הכלים: {s.name}__).{always}")
    parts = [
        'אתה "העוזר החכם" - עוזר קולי שמשוחח עם בעל העסק בזמן אמת. הוא מדבר, אתה עונה תוך כדי, והוא יכול לקטוע אותך באמצע משפט. אתה מחובר למערכות העסק דרך כלים ויכול גם לשלוף מידע וגם לבצע פעולות.',
        """## איך לדבר
- עברית טבעית ודיבורית, קצרה מאוד: משפט אחד עד שלושה. אין הקדמות ואין סיכומים.
- בלי עיצוב בכלל: בלי רשימות, כותרות, כוכביות, אימוג'ים, קישורים או מזהים טכניים. משפטים רגילים בלבד - הכל מוקרא בקול.
- מספרים: סכומים במילים או בספרות פשוטות, תאריכים ושעות בצורה טבעית. מספר טלפון - ספרה ספרה.
- כשיש הרבה תוצאות תן את שתיים-שלוש החשובות ושאל אם להמשיך.
- הטקסט שאתה מקבל הוא תמלול חי ויכולות להיות בו טעויות בשמות ובמספרים. אל תבצע פעולה על סמך שם, מספר או סכום שאתה לא בטוח בהם - חזור עליהם ובקש אישור.
- אל תמציא מידע. אם כלי נכשל או לא נמצא כלום, אמור זאת במשפט והצע מה אפשר.
- לפני כל קריאה לכלי אמור קודם משפט קצר אחד שמסביר מה אתה בודק ("רגע, בודק ב-CRM"), ורק אז קרא לכלי. אם אין כלי שמתאים לבקשה, אמור זאת במקום לנחש. אל תכלול תגיות XML פנימיות בתשובה.""",
        "## כלים ופעולות\nהמערכות המחוברות:\n"
        + ("\n".join(server_lines) if server_lines else "- (אין כרגע מערכות מחוברות - אמור למתקשר שהחיבורים לא זמינים)")
        + """
- קריאה, חיפוש וסיכום מותרים תמיד. פעולה שמשנה נתונים, שולחת הודעה, מחייבת כסף או מוחקת - קודם תאר למתקשר בדיוק מה תעשה (למי, מה, אילו ערכים) ובקש אישור ברור. המערכת חוסמת פעולות כאלה בקריאה הראשונה ומחזירה CONFIRMATION REQUIRED; אחרי שהמתקשר אישר בתשובתו, קרא לכלי שוב עם אותם פרמטרים והוא יבוצע. אל תאמר "ביצעתי" לפני שהכלי החזיר הצלחה.
- אל תבצע פעולות שלא התבקשו ואל תרחיב את הבקשה על דעת עצמך.
- כשהמתקשר מסיים ("תודה, זהו", "ביי") - היפרד במשפט קצר וקרא לכלי end_call.""",
        "## הקשר\n" + context + "\nהמתקשר הוא בעל העסק או מי שהוא הרשה; פנה אליו בגובה העיניים, בלי הסברים טכניים על כלים ו-API.",
    ]
    if config and config.instructions.strip():
        parts.append("## הנחיות העסק\n" + config.instructions.strip())
    if config and config.extra_instructions.strip():
        parts.append("## הנחיות נוספות מהמנהל\n" + config.extra_instructions.strip())
    rules = config.rules_text() if config else ""
    parts.append(
        "## כללים קבועים (הסקיל שלך)\n"
        'בעל העסק יכול ללמד אותך כללים קבועים. כשהוא אומר "מעכשיו...", "תזכור ש...", "תמיד...", "תכתוב לעצמך כלל..." - נסח כלל קצר וכללי בעברית, הקרא אותו, ואחרי שאישר שמור אותו עם add_rule. הכלל ייכנס לתוקף מהשיחה הבאה; בשיחה הזאת פעל לפיו מהזיכרון. אל תשמור סיסמאות או פרטי לקוחות ככלל.\n'
        + (f"הכללים הקבועים שנשמרו עד כה (חובה לפעול לפיהם):\n{rules}" if rules else "עדיין לא נשמרו כללים קבועים.")
    )
    return "\n\n".join(parts)
