import { describe, it, expect } from "vitest";
import { classifyTool, hasServerSideConfirmation, isBlocked, ConfirmationGate } from "../src/mcp/tool-policy.js";

describe("classifyTool", () => {
  it("trusts readOnlyHint / destructiveHint annotations over the name", () => {
    expect(classifyTool({ name: "send_whatsapp", annotations: { readOnlyHint: true } })).toBe("read");
    expect(classifyTool({ name: "get_contact", annotations: { destructiveHint: true } })).toBe("write");
    expect(classifyTool({ name: "get_contact", annotations: { readOnlyHint: false } })).toBe("read");
  });

  it("classifies read verbs by name", () => {
    for (const name of ["get_contact", "list_contacts", "search_contacts", "find_duplicates", "read_file", "fetch", "search", "check_availability", "inbox_summary", "revenue_report", "get_game_stats", "system_status", "whoami", "listening_report", "queue_realtime"]) {
      expect(classifyTool({ name }), name).toBe("read");
    }
  });

  it("classifies write verbs by name", () => {
    for (const name of ["send_whatsapp", "create_lead", "delete_contact", "manage_ticket", "update_contact", "set_status", "record_payment", "run_campaign", "hangup_all_active_calls", "mark_read", "merge_contacts", "add_note", "upload_file", "log_communication", "generate_questions"]) {
      expect(classifyTool({ name }), name).toBe("write");
    }
  });

  it("strips the server prefix before matching", () => {
    expect(classifyTool({ name: "crm__get_contact" })).toBe("read");
    expect(classifyTool({ name: "crm__send_whatsapp" })).toBe("write");
    expect(classifyTool({ name: "yemot__list_lines" })).toBe("read");
  });

  it("is conservative with unknown verbs", () => {
    expect(classifyTool({ name: "frobnicate_widget" })).toBe("write");
    expect(classifyTool({ name: "crm__zap" })).toBe("write");
    expect(classifyTool({ name: "" })).toBe("write");
  });

  it("is case-insensitive", () => {
    expect(classifyTool({ name: "GET_Contact" })).toBe("read");
    expect(classifyTool({ name: "Send_SMS" })).toBe("write");
  });
});

describe("hasServerSideConfirmation", () => {
  it("detects the known confirmation parameters", () => {
    for (const key of ["confirm", "confirmation_token", "confirmationToken", "confirm_token"]) {
      expect(hasServerSideConfirmation({ name: "x", inputSchema: { properties: { [key]: { type: "boolean" }, other: {} } } }), key).toBe(true);
    }
  });

  it("is false without such a parameter or without a schema", () => {
    expect(hasServerSideConfirmation({ name: "x", inputSchema: { properties: { to: {}, text: {} } } })).toBe(false);
    expect(hasServerSideConfirmation({ name: "x", inputSchema: {} })).toBe(false);
    expect(hasServerSideConfirmation({ name: "x" })).toBe(false);
  });
});

describe("isBlocked", () => {
  it("matches regex patterns case-insensitively against the full name", () => {
    expect(isBlocked("crm__delete_contact", ["^crm__delete_"])).toBe(true);
    expect(isBlocked("CRM__DELETE_CONTACT", ["__delete_"])).toBe(true);
    expect(isBlocked("crm__get_contact", ["^crm__delete_"])).toBe(false);
    expect(isBlocked("yemot__hangup_all_active_calls", ["hangup_all_active_calls", "transfer_units"])).toBe(true);
    expect(isBlocked("github__merge_pull_request", ["merge_pull_request$"])).toBe(true);
  });

  it("falls back to a plain substring match when the pattern is not a valid regex", () => {
    expect(isBlocked("weird[tool]", ["[tool"])).toBe(true);
    expect(isBlocked("weird(tool", ["(tool"])).toBe(true);
    expect(isBlocked("crm__get_contact", ["[tool"])).toBe(false);
  });

  it("ignores empty patterns and empty lists", () => {
    expect(isBlocked("crm__get_contact", [])).toBe(false);
    expect(isBlocked("crm__get_contact", ["", ""])).toBe(false);
  });
});

describe("ConfirmationGate", () => {
  const read = { name: "search_contacts" };
  const write = { name: "send_whatsapp", inputSchema: { properties: { to: {}, text: {} } } };
  const args = { to: "0501234567", text: "שלום" };

  it("always allows read tools", () => {
    const gate = new ConfirmationGate({ confirmWrites: true, blockedTools: [] });
    expect(gate.check(read, "crm__search_contacts", { q: "x" }, 1)).toEqual({ allowed: true });
    expect(gate.pendingCount()).toBe(0);
  });

  it("blocks a write tool on its first request and requires confirmation", () => {
    const gate = new ConfirmationGate({ confirmWrites: true, blockedTools: [] });
    const d = gate.check(write, "crm__send_whatsapp", args, 3);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("confirmation_required");
    expect(d.message).toContain("CONFIRMATION REQUIRED");
    expect(gate.pendingCount()).toBe(1);
  });

  it("keeps blocking within the same caller turn", () => {
    const gate = new ConfirmationGate({ confirmWrites: true, blockedTools: [] });
    gate.check(write, "crm__send_whatsapp", args, 3);
    expect(gate.check(write, "crm__send_whatsapp", args, 3).allowed).toBe(false);
    expect(gate.pendingCount()).toBe(1);
  });

  it("allows the same tool in the next caller turn, once", () => {
    const gate = new ConfirmationGate({ confirmWrites: true, blockedTools: [] });
    expect(gate.check(write, "crm__send_whatsapp", args, 3).allowed).toBe(false);
    expect(gate.check(write, "crm__send_whatsapp", args, 4)).toEqual({ allowed: true });
    expect(gate.pendingCount()).toBe(0);
    // The approval was consumed: another request must be confirmed again.
    const again = gate.check(write, "crm__send_whatsapp", args, 4);
    expect(again.allowed).toBe(false);
    expect(again.reason).toBe("confirmation_required");
    expect(gate.check(write, "crm__send_whatsapp", args, 5)).toEqual({ allowed: true });
  });

  it("also allows the request two turns later (default window of 2)", () => {
    const gate = new ConfirmationGate({ confirmWrites: true, blockedTools: [] });
    gate.check(write, "crm__send_whatsapp", args, 1);
    expect(gate.check(write, "crm__send_whatsapp", args, 3)).toEqual({ allowed: true });
  });

  it("expires the approval after the window", () => {
    const gate = new ConfirmationGate({ confirmWrites: true, blockedTools: [] });
    gate.check(write, "crm__send_whatsapp", args, 1);
    const late = gate.check(write, "crm__send_whatsapp", args, 4);
    expect(late.allowed).toBe(false);
    expect(late.reason).toBe("confirmation_required");
    // ... and the late request itself becomes the new pending approval.
    expect(gate.check(write, "crm__send_whatsapp", args, 5)).toEqual({ allowed: true });
  });

  it("expire() drops stale approvals when the caller moves on", () => {
    const gate = new ConfirmationGate({ confirmWrites: true, blockedTools: [] });
    gate.check(write, "crm__send_whatsapp", args, 1);
    gate.expire(2);
    expect(gate.pendingCount()).toBe(1);
    gate.expire(4);
    expect(gate.pendingCount()).toBe(0);
  });

  it("honours a custom approval window", () => {
    const gate = new ConfirmationGate({ confirmWrites: true, blockedTools: [], approvalWindowTurns: 1 });
    gate.check(write, "crm__send_whatsapp", args, 1);
    expect(gate.check(write, "crm__send_whatsapp", args, 3).allowed).toBe(false);
    gate.check(write, "crm__send_whatsapp", args, 5);
    expect(gate.check(write, "crm__send_whatsapp", args, 6).allowed).toBe(true);
  });

  it("tracks approvals per tool name", () => {
    const gate = new ConfirmationGate({ confirmWrites: true, blockedTools: [] });
    gate.check(write, "crm__send_whatsapp", args, 1);
    expect(gate.check({ name: "send_email" }, "crm__send_email", {}, 2).allowed).toBe(false);
    expect(gate.check(write, "crm__send_whatsapp", args, 2).allowed).toBe(true);
  });

  it("rejects blocked tools before anything else, even read tools", () => {
    const gate = new ConfirmationGate({ confirmWrites: true, blockedTools: ["__delete_", "^crm__get_secret$"] });
    const d = gate.check({ name: "delete_contact" }, "crm__delete_contact", {}, 1);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("blocked");
    expect(d.message).toMatch(/blocked/i);
    expect(gate.check({ name: "get_secret" }, "crm__get_secret", {}, 1).reason).toBe("blocked");
    expect(gate.check({ name: "delete_contact" }, "crm__delete_contact", {}, 2).allowed).toBe(false);
    expect(gate.pendingCount()).toBe(0);
  });

  it("never runs write tools on a read-only server", () => {
    const gate = new ConfirmationGate({ confirmWrites: true, blockedTools: [] });
    const d = gate.check(write, "crm__send_whatsapp", args, 1, true);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("read_only_server");
    expect(gate.check(write, "crm__send_whatsapp", args, 2, true).allowed).toBe(false);
    expect(gate.check(read, "crm__search_contacts", {}, 1, true)).toEqual({ allowed: true });
  });

  it("lets writes through immediately when confirmWrites is off", () => {
    const gate = new ConfirmationGate({ confirmWrites: false, blockedTools: [] });
    expect(gate.check(write, "crm__send_whatsapp", args, 1)).toEqual({ allowed: true });
  });

  it("lets tools with their own confirm handshake through immediately", () => {
    const gate = new ConfirmationGate({ confirmWrites: true, blockedTools: [] });
    const twoStep = { name: "send_sms", inputSchema: { properties: { to: {}, confirm: { type: "boolean" } } } };
    expect(gate.check(twoStep, "yemot__send_sms", { to: "x", confirm: false }, 1)).toEqual({ allowed: true });
  });
});
