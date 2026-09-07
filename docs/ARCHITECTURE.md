# MAINBOT architecture

Developer reference for the Hebrew voice assistant that sits between the Technoline PBX and Claude. User-facing docs are in the Hebrew [README](../README.md); this file explains how the pieces fit together.

```
 caller ──▶ Technoline PBX ──GET──▶ Fastify (src/server.ts)
                                      ├─ /pbx/technoline/:secret   TechnolineCallFlow (src/pbx/technoline/route.ts)
                                      │      └─ SessionStore ──▶ VoiceAgent (src/agent/agent.ts)
                                      │                             ├─ Anthropic Messages API (beta: tool search, adaptive thinking, fallbacks)
                                      │                             ├─ McpHub (src/mcp/hub.ts) ──▶ remote MCP servers (OAuth / bearer)
                                      │                             ├─ ConfirmationGate (src/mcp/tool-policy.ts)
                                      │                             └─ local tools: end_call, list/add/update/remove_rule
                                      ├─ /admin, /admin/api/*      admin UI + JSON API (src/admin/*)
                                      ├─ /oauth/callback/:name     OAuth redirect target
                                      ├─ /health                   status JSON
                                      └─ /audio/silence.wav        filler audio when fillerMode = silence
 disk: data/settings.json, data/rules.json, data/usage/YYYY-MM.jsonl, .mcp-auth/<server>.json, config/*
```

## Module map

| File | Responsibility |
|---|---|
| `src/server.ts` | Builds the Fastify app (`buildServer`), wires stores, hub, agent and routes; raises `maxHeaderSize` to 512 KB because the PBX accumulates every module result in the query string; `/health`, `/audio/silence.wav`, session sweeper, graceful shutdown. |
| `src/config.ts` | Reads the environment once (`env`), defines the runtime `SettingsSchema` (zod) and `SettingsStore` (persisted to `data/settings.json`), phone normalisation and allow-list check. |
| `src/logger.ts` | pino logger; pretty output unless `NODE_ENV=production` (override with `LOG_PRETTY=1`). |
| `src/pbx/technoline/types.ts` | Typed subset of the PBX API module: request params and the JSON modules we return (`simpleMessage`, `stt`, `getDTMF`, `simpleMenu`, `goTo`, `hangup`, ...). |
| `src/pbx/technoline/request.ts` | Parses the PBX query string into a `PbxRequest`; reads `stt` results (`FILE_`, `DURATION_`, ...); finds the newest `utt_N` after a restart. |
| `src/pbx/technoline/builder.ts` | Helpers that build modules: `say`, `listen`, `getDigits`, `menu`, `hangup`, `chain`. Turns model text into TTS items via `splitForSpeech`. |
| `src/pbx/technoline/route.ts` | `TechnolineCallFlow` - the per-request state machine (auth, PIN, utterance handling, long-poll fillers, hangup) and the Fastify route with the secret check. |
| `src/calls/session.ts` | `CallSession` / `PendingJob` types and the in-memory `SessionStore` with TTL sweep. |
| `src/agent/agent.ts` | `VoiceAgent`: builds the tool list (tool search + deferred MCP tools + local tools), runs the Claude tool loop per caller turn, applies the confirmation gate, records usage, compacts long histories. |
| `src/agent/prompt.ts` | Cacheable system prompt (voice style, tool rules, business instructions, standing rules) and the per-call context block (caller, Gregorian + Hebrew date, time). |
| `src/agent/local-tools.ts` | Tools implemented in-process: `end_call`, `list_rules`, `add_rule`, `update_rule`, `remove_rule`, `list_routines`, `add_routine`, `toggle_routine`, `remove_routine`, and (proactive runs only) `notify_owner`. |
| `src/routines/store.ts` | `RoutineStore` - proactive routines (cron / interval / event / manual) persisted to `data/routines.json`. |
| `src/routines/cron.ts` | Dependency-free 5-field cron matcher and next-run calculator evaluated in the configured time zone; quiet-hours check. |
| `src/routines/runner.ts` | `RoutineRunner` - 30 s tick, event dispatch, manual runs; runs each routine as a serialised `proactive` conversation and records the result. |
| `src/routines/notify.ts` | `Notifier` - delivers `notify_owner` messages through MCP tools (channel -> tool templates in settings): WhatsApp/email via the CRM, SMS via Yemot, or log only. |
| `src/agent/rules.ts` | `RulesStore` - standing rules dictated by the owner, persisted to `data/rules.json`, rendered into the prompt. |
| `src/agent/speech-text.ts` | Normalises model output for Hebrew TTS (strips markdown/URLs/emoji, expands symbols), splits into short segments, extracts phone numbers and long digit runs as `digits` items. |
| `src/mcp/config.ts` | zod schema for `config/mcp-servers.json`, `${ENV}` interpolation, static auth headers. |
| `src/mcp/hub.ts` | `McpHub`: one MCP client per server (Streamable HTTP with SSE fallback), tool catalog with prefixed names, tool execution with one reconnect retry, OAuth login/logout, status for the admin UI. |
| `src/mcp/oauth-provider.ts` | `FileOAuthProvider` - `OAuthClientProvider` backed by `.mcp-auth/<server>.json` (tokens, dynamic client registration, PKCE verifier, state). |
| `src/mcp/tool-policy.ts` | Read/write classification, blocked-tool patterns, server-side confirmation detection and the `ConfirmationGate`. |
| `src/usage/pricing.ts` | Price table per model and `estimateCostUsd`. |
| `src/usage/usage-store.ts` | Append-only JSONL usage log (`llm`, `tool`, `turn`, `call` events) kept in memory with aggregation for the dashboard. |
| `src/admin/routes.ts` | Basic-auth admin API: state, settings, usage, call transcripts, rules, instructions file, text chat, MCP reconnect/logout/login, OAuth callback. |
| `src/admin/ui.ts` | The single-page Hebrew admin UI (inline HTML/CSS/JS) served at `/admin`. |
| `src/cli/mcp-login.ts` | Referenced by `npm run mcp:login -- <server>`: runs the OAuth flow from the terminal with a local callback on `MCP_OAUTH_CALLBACK_PORT`. |
| `src/cli/mcp-tools.ts` | Referenced by `npm run mcp:tools`: connects to the configured servers and lists their tools. |
| `src/cli/chat.ts` | Referenced by `npm run chat`: text chat with the same agent from the terminal. |
| `config/mcp-servers.json` | The remote MCP servers (loaded at boot). |
| `config/instructions.md` | Business instructions injected into the system prompt (editable from `/admin`). |
| `test/*.test.ts` | vitest suites for the PBX adapter, call flow, agent loop, speech text, tool policy, usage, config and the HTTP server. |

## One caller turn, step by step

1. **PBX request.** `GET /pbx/technoline/<secret>?PBXphone=..&PBXcallId=..&PBXcallStatus=CALL&utt_3=<transcript>&utt_2=..&utt_1=..`. The route rejects a wrong secret with 403 and a missing `PBXcallId` with 400, then merges query + body and calls `TechnolineCallFlow.handle`.
2. **Session lookup.** `SessionStore.get(callId)`; a missing session is created (and, if `utt_N` params are already present, recovered as a restart mid-call). A `HANGUP` status finalises the session and returns `{}`.
3. **Authorisation.** First request only: caller must match `settings.allowedPhones` (else a spoken refusal + `hangup`), then the optional PIN loop via `getDTMF` (`pin_1`, `pin_2`, ...).
4. **Pending job?** If Claude is still working on the previous utterance (`session.pending`), skip to step 7.
5. **New utterance.** The flow expects exactly one parameter (`session.expectedParam`, e.g. `utt_3`). If present and not yet in `session.consumed`, it is consumed: empty text counts as a silent turn (re-prompt, then goodbye after `maxSilentTurns`); non-empty text bumps `turns` (goodbye after `maxTurns`) and starts the agent job in the background (`startJob`).
6. **Agent job** (`VoiceAgent.respond`): increments `conv.turn`, expires stale approvals, compacts history when it exceeds 60 messages, prepends the call-context block to the first user message, then loops:
   - `client.beta.messages.create` with the cached system prompt, `tools` (search tool + local tools + MCP tools with `defer_loading`), `thinking: {type: "adaptive"}`, `output_config.effort`, optional `fallbacks: "default"` + beta header.
   - Usage is recorded from `response.usage`. `stop_reason === "refusal"` returns a fixed apology; `pause_turn` loops again; no `tool_use` blocks ends the loop.
   - Each `tool_use` runs concurrently: `end_call` flips `endCall`; rule tools run locally; MCP tools pass through the `ConfirmationGate` and then `McpHub.callTool` (with `TOOL_TIMEOUT_MS`). Results are appended as a `user` message of `tool_result` blocks.
   - Stops after `maxIterationsPerTurn` requests or `AGENT_TIMEOUT_MS` (abort signal). Errors become a short spoken Hebrew apology and the transcript is repaired so it never ends with a dangling `tool_use`.
7. **Long-poll.** `waitOrFiller` races the job against `PBX_LONG_POLL_MS`. If the job is still running, a filler `simpleMessage` (or the silence file) is returned; the PBX plays it and calls again with the same params, which lands in step 4. Each filler is counted on the job.
8. **Reply.** When the job resolves: `[simpleMessage(answer), stt(utt_4)]`, or `[simpleMessage(answer), hangup]` when `endCall` is set (session finalised with `agent_end`).
9. **Finalisation** (`finalize`): marks the session ended, records a `call` usage event with the reason (`caller_hangup`, `agent_end`, `unauthorized`, `pin_failed`, `silence`, `max_turns`), keeps the session for 60 s so the trailing `HANGUP` is recognised, then deletes it. Idle sessions are also swept every minute after `SESSION_TTL_MS`.

## Session state

`CallSession` (`src/calls/session.ts`), one per `PBXcallId`, in memory only:

| Field | Meaning |
|---|---|
| `callId`, `phone` | From `PBXcallId` / `PBXphone`. |
| `startedAt`, `lastActivity` | Creation time and last request time (TTL sweep). |
| `conv` | The `ConversationState` for Claude (below). |
| `authorized` | Allow-list (and PIN) passed. |
| `pinAttempts` | Wrong PINs so far; also numbers the `pin_N` parameter. |
| `expectedParam` | The query parameter we are waiting for (`utt_3`, `pin_1`) or `null`. |
| `consumed` | Set of parameter names already handled - required because the PBX re-sends every accumulated value on every request. |
| `utteranceIndex` | Counter behind `utt_N`. |
| `pending` | The running agent job (`PendingJob`: `utterance`, `startedAt`, `fillers`, `promise`, `result`) or `null`. |
| `silentTurns` | Consecutive empty / missing utterances. |
| `turns` | Non-empty caller utterances so far. |
| `ended`, `endedBy` | Finalised flag and reason. |

`ConversationState` (`src/agent/agent.ts`), owned by the session (or by an admin chat):

| Field | Meaning |
|---|---|
| `callId`, `phone` | Copied for usage records. |
| `messages` | The Anthropic message history (assistant content incl. thinking / tool_use blocks is passed back unchanged). |
| `turn` | Caller-turn counter used by the confirmation gate. |
| `gate` | The per-call `ConfirmationGate`. |
| `contextSent` | Whether the call-context block was already prepended. |

## Confirmation gate rules

`ConfirmationGate.check(tool, fullName, args, turn, serverReadOnly)` runs before every MCP tool call and every local write tool (`add_rule`, `update_rule`, `remove_rule`, `add_routine`, `toggle_routine`, `remove_routine`). The gate reads `blockedTools` / `confirmWrites` from the live settings on every check, so an admin change applies to conversations that are already open. Decisions, in order:

1. **Blocked** - `fullName` matches any pattern in `settings.blockedTools` (each entry is tried as a case-insensitive regex, falling back to substring). Denied with reason `blocked`; the model is told to say it must be done from the computer. Never overridable.
2. **Classification** (`classifyTool`): `annotations.readOnlyHint === true` → read; `annotations.destructiveHint === true` → write; otherwise the tool's base name (after `__`) is matched against write verbs (`create|add|update|delete|remove|send|set|manage|mark|merge|...`) first, then read verbs (`get|list|search|find|read|fetch|check|...`, suffixes `_summary|_report|_stats|_status|...`). Unknown verbs are treated as **write**.
3. **Read tools** run immediately.
4. **Read-only server** (`readOnly: true` in `mcp-servers.json`) - every write is denied with reason `read_only_server`.
5. **No confirmation needed** when `settings.confirmWrites` is `false`, or the call is the *preview* step of a server-side handshake: the tool's input schema has a handshake property (`confirm`, `confirmation_token`, `confirmationToken`, `confirm_token`) and the call carries neither `confirm: true` nor a token, so the server only describes the action. The executing call (`confirm: true` / a token) goes through step 6 like any other write, so the model cannot skip the caller by confirming itself.
6. **Two-turn handshake.** The first request for `fullName` in caller turn *N* is denied with reason `confirmation_required` and a `CONFIRMATION REQUIRED` message; the pending entry `{turn: N, args}` is stored per tool name. A request for the same tool in turn *N+1* or *N+2* (`approvalWindowTurns = 2`) is allowed and clears the entry. Requests in the same turn *N* stay denied, so the model cannot "confirm" itself. `expire(turn)` drops entries older than the window at the start of each turn.

The system prompt mirrors these rules in Hebrew so the model describes the action, waits for a spoken "yes", and only then calls the tool again with the same arguments.

## Tool naming

- Exposed name: `<server>__<tool>` (`toolFullName` in `src/mcp/hub.ts`). Any character outside `[A-Za-z0-9_-]` becomes `_`.
- The Anthropic API limits tool names to 64 characters. Longer names are truncated to 57 characters plus `_` plus the first 6 hex characters of the SHA-1 of the full name, so they stay unique.
- Server `name` must match `^[a-z0-9][a-z0-9_-]{0,19}$` (max 20 chars) to leave room for the tool part.
- The catalog also carries `kind` (`read` / `write`), `alwaysLoad` and `serverReadOnly`; tool descriptions sent to Claude are prefixed with `[read]` / `[write]` and the server name.
- With tool search on, the tool list is: `tool_search_tool_regex_20251119` (or the bm25 variant), the five local tools, then every MCP tool - those not in `alwaysLoad` carry `defer_loading: true`. Local tools are never deferred, which also satisfies the "at least one non-deferred tool" requirement.

## Runtime settings (`data/settings.json`)

Managed by `SettingsStore`; defaults come from the environment at boot, stored values win afterwards. Fields: `model`, `effort`, `maxTokens`, `fallbacks`, `toolSearch`, `toolSearchVariant`, `maxIterationsPerTurn`, `ttsVoice`, `greeting`, `goodbye`, `fillerMode`, `allowedPhones`, `pinHash`, `maxPinAttempts`, `confirmWrites`, `blockedTools`, `sttMaxSeconds`, `maxTurns`, `maxSilentTurns`, `extraInstructions`. `SettingsStore.view()` never returns `pinHash` (only `hasPin`). Every change notifies the agent, which rebuilds the system prompt and tool list.

## What is stored on disk

| Path | Content | Notes |
|---|---|---|
| `data/settings.json` | Runtime settings (above), including the PIN hash and the allow-list. | Written on every save from `/admin`. |
| `data/rules.json` | `{ nextId, rules: [{id, text, createdAt, updatedAt, source}] }` - standing rules. | Written atomically (tmp + rename). Max 200 rules, 600 chars each. |
| `data/routines.json` | `{ routines: [{id, name, enabled, schedule, prompt, channel, quietHours, source, lastRunAt, lastResult}] }` - proactive routines. | Written atomically. Max 100 routines. |
| `data/usage/YYYY-MM.jsonl` | One JSON event per line: `llm` (tokens, model, cost estimate, stop reason), `tool` (name, server, duration, ok/blocked), `turn` (caller text + assistant text), `call` (start/end, turns, reason). | All files are loaded into memory at boot; archive old months elsewhere if the directory grows large. Contains transcripts - treat as sensitive. |
| `.mcp-auth/<server>.json` | OAuth tokens, registered client, PKCE verifier, `state`, discovery state, redirect URL. | Mode 0600. Deleted by "logout". Re-registered when the redirect URL changes (CLI vs admin). |
| `config/mcp-servers.json` | Server list. | Read once at boot. |
| `config/instructions.md` | Business instructions. | Rewritten by `PUT /admin/api/instructions`; must be writable in production. |

Nothing else is persisted: call sessions, admin chat sessions and the tool catalog live in memory, which is why a single instance must run.

## HTTP endpoints

| Method + path | Auth | Purpose |
|---|---|---|
| `GET`/`POST /pbx/technoline/:secret` | path secret | PBX webhook. |
| `GET /health` | none | `{ ok, servers: [{name, state, tools}], activeCalls, model }`. |
| `GET /audio/silence.wav` | none | 3 s of silence for `fillerMode = silence`. |
| `GET /` | none | Redirects to `/admin`. |
| `GET /admin` | basic | Admin UI. |
| `GET /admin/api/state` | basic | Settings view, servers + tools, models, voices, webhook URL, active calls. |
| `PUT /admin/api/settings` | basic | Partial settings update (`pin` sets/clears the PIN). |
| `GET /admin/api/usage?range=today|7d|30d` | basic | Aggregate + last 100 calls. |
| `GET /admin/api/calls/:callId` | basic | All usage events of one call (transcript). |
| `GET /admin/api/prompt` | basic | Current system prompt. |
| `GET/POST/PUT/DELETE /admin/api/rules[/:id]` | basic | Standing rules CRUD (`PUT /admin/api/rules` replaces all). |
| `GET/POST/PUT/DELETE /admin/api/routines[/:id]`, `POST /admin/api/routines/:id/run`, `GET /admin/api/routines/:id/runs` | basic | Proactive routines CRUD, run now, run log. |
| `POST /admin/api/notify/test` | basic | Sends a test message on a notification channel. |
| `POST /api/v1/events` | bearer (`CHAT_API_KEY`) | External event -> runs the routines subscribed to `type` (202, background). |
| `GET/PUT /admin/api/instructions` | basic | Read / write `config/instructions.md`. |
| `POST /admin/api/chat` | basic | Text chat with the agent (`message`, `sessionId`, `reset`). |
| `POST /admin/api/mcp/:name/reconnect`, `/logout` | basic | Server actions. |
| `GET /admin/mcp/:name/login` | basic | Starts OAuth and redirects to the authorization server. |
| `GET /oauth/callback/:name` | none (state check) | OAuth redirect target. |

## Timeouts and limits

| Setting | Default | Where |
|---|---|---|
| PBX response timeout | ~30 s | PBX side (fixed). |
| `PBX_LONG_POLL_MS` | 20 s | `env`; must stay below the PBX timeout. |
| STT max | 10 s per utterance | PBX limit; `sttMaxSeconds` setting is capped at 10. |
| `AGENT_TIMEOUT_MS` | 180 s | Whole caller turn. |
| Anthropic request timeout | 120 s | Hard-coded per request in `agent.ts`. |
| `TOOL_TIMEOUT_MS` | 60 s | One MCP call. |
| `maxIterationsPerTurn` | 12 | Claude round-trips per turn. |
| `maxTurns` / `maxSilentTurns` | 60 / 2 | Per call. |
| `MAX_HISTORY_MESSAGES` | 60 | Compaction threshold (summary with `effort: low`). |
| `SESSION_TTL_MS` | 30 min | Idle session sweep. |
| HTTP header size | 512 KB | `serverFactory` in `server.ts`. |
