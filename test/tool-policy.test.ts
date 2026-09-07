import { describe, it, expect } from "vitest";
import { classifyTool, hasServerSideConfirmation, isHandshakePreview, isBlocked, ConfirmationGate } from "../src/mcp/tool-policy.js";
import { DEFAULT_BLOCKED_TOOLS } from "../src/config.js";

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

  it("default patterns cover vendor-prefixed deletes and the SUMIT money-moving tools", () => {
    const defaults = [...DEFAULT_BLOCKED_TOOLS];
    for (const name of ["crm__delete_contact", "clicker__delete_game", "sumit__sumit_crm_delete_entity", "sumit__sumit_documents_cancel", "sumit__sumit_recurring_cancel", "sumit__sumit_payments_refund", "sumit__sumit_permissions_remove", "sumit__sumit_payment_methods_remove", "yemot__hangup_all_active_calls"]) {
      expect(isBlocked(name, defaults), name).toBe(true);
    }
    for (const name of ["sumit__sumit_documents_list", "sumit__sumit_payments_charge", "sumit__sumit_customers_create", "crm__list_contacts", "crm__send_whatsapp"]) {
      expect(isBlocked(name, defaults), name).toBe(false);
    }
  });
});

describe("isHandshakePreview", () => {
  const boolTool = { name: "send_sms", inputSchema: { properties: { to: {}, text: {}, confirm: { type: "boolean" } } } };
  const tokenTool = { name: "delete_game", inputSchema: { properties: { id: {}, confirmation_token: { type: "string" } } } };

  it("is true only for the preview step", () => {
    expect(isHandshakePreview(boolTool, { to: "x" })).toBe(true);
    expect(isHandshakePreview(boolTool, { to: "x", confirm: false })).toBe(true);
    expect(isHandshakePreview(boolTool, { to: "x", confirm: true })).toBe(false);
    expect(isHandshakePreview(boolTool, { to: "x", confirm: "true" })).toBe(false);
    expect(isHandshakePreview(boolTool, { to: "x", confirm: "yes" })).toBe(false);
    expect(isHandshakePreview(tokenTool, { id: "g1" })).toBe(true);
    expect(isHandshakePreview(tokenTool, { id: "g1", confirmation_token: "" })).toBe(true);
    expect(isHandshakePreview(tokenTool, { id: "g1", confirmation_token: "tok_123" })).toBe(false);
    expect(isHandshakePreview({ name: "send_whatsapp", inputSchema: { properties: { to: {} } } }, { to: "x" })).toBe(false);
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

  it("requires a new confirmation when the arguments change", () => {
    const gate = new ConfirmationGate({ confirmWrites: true, blockedTools: [] });
    gate.check(write, "crm__send_whatsapp", args, 1);
    // Same tool, different recipient: the caller approved a message to someone else.
    const other = { to: "0529999999", text: "שלום" };
    const d = gate.check(write, "crm__send_whatsapp", other, 2);
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("confirmation_required");
    expect(d.message).toMatch(/arguments differ/i);
    expect(gate.pendingCount()).toBe(1);
    // The changed request became the pending one and is approved on the next turn as usual.
    expect(gate.check(write, "crm__send_whatsapp", other, 3)).toEqual({ allowed: true });
  });

  it("replaces a pending request when the model changes the arguments within the same turn", () => {
    const gate = new ConfirmationGate({ confirmWrites: true, blockedTools: [] });
    const other = { to: "0529999999", text: "שלום" };
    gate.check(write, "crm__send_whatsapp", args, 1);
    gate.check(write, "crm__send_whatsapp", other, 1);
    expect(gate.pendingCount()).toBe(1);
    expect(gate.check(write, "crm__send_whatsapp", other, 2)).toEqual({ allowed: true });
  });

  it("treats the same arguments in a different key order as the same request", () => {
    const gate = new ConfirmationGate({ confirmWrites: true, blockedTools: [] });
    gate.check(write, "crm__send_whatsapp", { to: "0501234567", text: "שלום", opts: { a: 1, b: [1, 2] } }, 1);
    expect(gate.check(write, "crm__send_whatsapp", { opts: { b: [1, 2], a: 1 }, text: "שלום", to: "0501234567" }, 2)).toEqual({ allowed: true });
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

  it("gates the executing step of a server-side handshake like any other write", () => {
    const gate = new ConfirmationGate({ confirmWrites: true, blockedTools: [] });
    const twoStep = { name: "send_sms", inputSchema: { properties: { to: {}, confirm: { type: "boolean" } } } };
    // preview passes, confirm:true on the same turn does not
    expect(gate.check(twoStep, "yemot__send_sms", { to: "x" }, 1).allowed).toBe(true);
    const first = gate.check(twoStep, "yemot__send_sms", { to: "x", confirm: true }, 1);
    expect(first).toMatchObject({ allowed: false, reason: "confirmation_required" });
    expect(gate.check(twoStep, "yemot__send_sms", { to: "x", confirm: true }, 1).allowed).toBe(false);
    // the caller said yes in the next turn
    expect(gate.check(twoStep, "yemot__send_sms", { to: "x", confirm: true }, 2)).toEqual({ allowed: true });
    // token handshakes behave the same
    const tokenTool = { name: "delete_game", inputSchema: { properties: { id: {}, confirmation_token: {} } } };
    expect(gate.check(tokenTool, "clicker__delete_game", { id: "g1" }, 3).allowed).toBe(true);
    expect(gate.check(tokenTool, "clicker__delete_game", { id: "g1", confirmation_token: "t" }, 3).allowed).toBe(false);
    expect(gate.check(tokenTool, "clicker__delete_game", { id: "g1", confirmation_token: "t" }, 4).allowed).toBe(true);
  });

  it("reads live options when given a function", () => {
    let opts = { confirmWrites: false, blockedTools: [] as string[] };
    const gate = new ConfirmationGate(() => opts);
    expect(gate.check(write, "crm__send_whatsapp", args, 1)).toEqual({ allowed: true });
    opts = { confirmWrites: true, blockedTools: ["send_whatsapp"] };
    expect(gate.check(write, "crm__send_whatsapp", args, 2)).toMatchObject({ allowed: false, reason: "blocked" });
    opts = { confirmWrites: true, blockedTools: [] };
    expect(gate.check(write, "crm__send_whatsapp", args, 3)).toMatchObject({ allowed: false, reason: "confirmation_required" });
  });
});
