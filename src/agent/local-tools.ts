import type Anthropic from "@anthropic-ai/sdk";

export const END_CALL_TOOL = "end_call";

/** Tools implemented inside the bot itself (not from MCP). Always loaded. */
export const LOCAL_TOOLS: Anthropic.Beta.BetaTool[] = [
  {
    name: END_CALL_TOOL,
    description:
      "Ends the phone call after your current message is spoken. Call it when the caller says goodbye or that they are done, in the same response as your farewell sentence.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];
