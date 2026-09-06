import type Anthropic from "@anthropic-ai/sdk";
import type { RulesStore } from "./rules.js";

export const END_CALL_TOOL = "end_call";
export const LIST_RULES_TOOL = "list_rules";
export const ADD_RULE_TOOL = "add_rule";
export const UPDATE_RULE_TOOL = "update_rule";
export const REMOVE_RULE_TOOL = "remove_rule";

/** Local tools that change persisted state and therefore go through the confirmation gate. */
export const LOCAL_WRITE_TOOLS = new Set([ADD_RULE_TOOL, UPDATE_RULE_TOOL, REMOVE_RULE_TOOL]);

/** Tools implemented inside the bot itself (not from MCP). Always loaded. */
export const LOCAL_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: END_CALL_TOOL,
    description:
      "Ends the phone call after your current message is spoken. Call it when the caller says goodbye or that they are done, in the same response as your farewell sentence.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: LIST_RULES_TOOL,
    description:
      "Lists the standing rules (the assistant's permanent skill) that the owner dictated in earlier calls, with their numbers. The same rules are already in your instructions; use this only when the caller asks what rules exist or which number a rule has.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: ADD_RULE_TOOL,
    description:
      "Saves a new permanent rule for yourself, written in Hebrew as a short imperative sentence (e.g. 'כשמדווחים על לידים, תמיד לציין את הטלפון'). Use it when the owner says things like 'מעכשיו', 'תזכור ש', 'תמיד', 'אף פעם', 'תכתוב לעצמך כלל'. Read the exact rule text back to the caller and get a yes before it is saved; it takes effect from the next call. Never store passwords or secrets in a rule.",
    input_schema: {
      type: "object",
      properties: { text: { type: "string", description: "The rule text in Hebrew, one or two sentences, general enough to apply in future calls." } },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: UPDATE_RULE_TOOL,
    description: "Rewrites the text of an existing permanent rule by its number (see list_rules or the numbered rules in your instructions). Read the new text back and get a yes first.",
    input_schema: {
      type: "object",
      properties: { id: { type: "integer", description: "Rule number" }, text: { type: "string", description: "New rule text in Hebrew" } },
      required: ["id", "text"],
      additionalProperties: false,
    },
  },
  {
    name: REMOVE_RULE_TOOL,
    description: "Deletes a permanent rule by its number. Read the rule back and get a yes first.",
    input_schema: {
      type: "object",
      properties: { id: { type: "integer", description: "Rule number" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

export const LOCAL_TOOL_NAMES = new Set(LOCAL_TOOLS.map((t) => t.name));

export interface LocalToolResult {
  text: string;
  isError: boolean;
}

/** Executes a local tool (never throws). end_call is handled by the agent itself. */
export function runLocalTool(name: string, input: Record<string, unknown>, rules: RulesStore, source: string): LocalToolResult {
  try {
    switch (name) {
      case LIST_RULES_TOOL:
        return { text: rules.renderForTool(), isError: false };
      case ADD_RULE_TOOL: {
        const rule = rules.add(String(input.text ?? ""), source);
        return { text: `נשמר ככלל ${rule.id}: ${rule.text}. הכלל ייכנס לתוקף מהשיחה הבאה.`, isError: false };
      }
      case UPDATE_RULE_TOOL: {
        const rule = rules.update(Number(input.id), String(input.text ?? ""), source);
        return { text: `כלל ${rule.id} עודכן: ${rule.text}`, isError: false };
      }
      case REMOVE_RULE_TOOL: {
        const rule = rules.remove(Number(input.id));
        return { text: `כלל ${rule.id} נמחק: ${rule.text}`, isError: false };
      }
      default:
        return { text: `Unknown local tool ${name}`, isError: true };
    }
  } catch (err) {
    return { text: `Rule error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
  }
}
