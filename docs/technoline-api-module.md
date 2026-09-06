# Technoline PBX — API Module Documentation

> Full technical reference for integrating with the Technoline PBX via API.

---

## Table of Contents

- [How It Works](#how-it-works)
  - [HTTP transport — exact wire format](#http-transport--exact-wire-format)
- [Mental Model — Read This Before Generating Any JSON](#mental-model--read-this-before-generating-any-json)
  - [Language — Hebrew is the default; other languages also work](#language--hebrew-is-the-default-other-languages-also-work)
  - [The PBX accumulates `name` values automatically — your server is stateless](#the-pbx-accumulates-name-values-automatically--your-server-is-stateless)
  - [Chaining vs. splitting — when arrays are allowed](#chaining-vs-splitting--when-arrays-are-allowed)
  - [Modules exposed via this API](#modules-exposed-via-this-api--this-is-the-complete-list)
- [Fixed Parameters](#fixed-parameters)
  - [Template substitution — `{{PBXparam}}`](#template-substitution--pbxparam-inside-module-fields)
- [Response Format](#response-format)
- [Modules](#modules)
  - [simpleMessage](#simplemessage)
  - [simpleMenu](#simplemenu)
  - [getDTMF](#getdtmf)
  - [record](#record)
  - [stt — Speech to Text](#stt--speech-to-text)
  - [simpleRouting](#simplerouting)
  - [ipRouting](#iprouting)
  - [audioPlayer](#audioplayer)
  - [goTo](#goto)
  - [hangup](#hangup)
  - [creditCard](#creditcard)
- [The `files` Object](#the-files-object)
- [Chaining Commands](#chaining-commands)
- [record & stt Response Parameters](#record--stt-response-parameters)
- [Full Worked Example — Donation Flow](#full-worked-example--donation-flow)
- [Quick Reference](#quick-reference)

---

## How It Works

The PBX acts as an **HTTP client**. When a caller enters an extension, the PBX sends a `GET` request to your configured URL and expects a `JSON` response.

```
[Caller] → [PBX] → GET https://yourserver.com/endpoint?PBXphone=050...
                              ↓
                       JSON { "type": "..." }
                              ↓
                       [PBX executes module]
                              ↓
           GET https://yourserver.com/endpoint?...&yourParam=result
```

**Rules:**
- Invalid or missing JSON response → caller is returned to the previous menu
- Each module appends its result as a query parameter to the next request
- Multiple modules can be sent as an array — all execute in sequence, all values return together in one request

### HTTP transport — exact wire format

| Aspect | Detail |
|---|---|
| Request method | `GET` (the PBX is the HTTP client; your server is the HTTP server) |
| Request URL | The base URL configured in the PBX admin, with query parameters appended each round-trip |
| Response status | `200 OK` |
| Response Content-Type | `application/json; charset=utf-8` |
| Response body | A single JSON object **or** a JSON array of objects — placed in the **response body**, not the URL |
| Response encoding | **UTF-8 is mandatory** for Hebrew `text` fields. Wrong encoding = garbled TTS. |
| Response timeout | ~30 seconds. After that the PBX gives up on this round-trip and falls back to the previous menu. |
| Empty body / non-JSON / HTTP error | Treated as "no instruction" — the caller is returned to the previous menu, or the call ends if there is none. |

> The request method is `GET`, but the JSON instruction is in the **response body** (not in the URL). Your handler reads `$_GET` for incoming PBX parameters, builds a JSON object, and writes it to the response body with `Content-Type: application/json; charset=utf-8`.

---

## Mental Model — Read This Before Generating Any JSON

> **This section is critical for AI code generators.** Most generation errors come from skipping it. Read all of it before writing a single module.

Your server is **reactive only**. You do **not** control the call. You do **not** speak to the caller. You do **not** collect input directly. You do **not** call external services on the caller's behalf.

The PBX runs the call. Your server only **answers** when the PBX asks: *"What should I do next?"* — by returning a JSON module (or an array of modules).

### Division of responsibility

| The PBX does (automatically) | Your server does |
|---|---|
| Plays audio to the caller | Decides which audio to send (`files` array) |
| Collects DTMF input | Receives the collected value as a query parameter |
| Records voice, encodes the file, uploads to storage | Receives the resulting file name and metadata |
| Routes the call to a phone or SIP endpoint | Decides the destination |
| **Charges the credit card — entire flow, end-to-end** | **Sets the amount and a few flags. Nothing else.** |
| Announces success / failure / confirmation numbers in Hebrew | Receives the final status |
| Validates expiry dates, retries on bad input, plays error prompts | — |
| Plays Hebrew prompts at every step of every module | — |

### One module = one complete subtask (black box)

Each module is a **black box**: you set parameters, the PBX runs the entire caller interaction, your server gets the final result on the next request.

What a **single module** handles internally — you do not need to (and must not) replicate any of these steps yourself:

| Module | What runs internally on the PBX |
|---|---|
| `creditCard` | Amount confirmation, card # collection, expiry collection + validation, CVV collection, ID collection, installments selection, **processor submission to Nedarim Plus**, success/failure announcement, confirmation-number readback, retry-on-failure loop (if `noFailExit="yes"`), end menu |
| `record` | Prompt audio, beep, recording, silence detection, optional re-listen, optional re-record, file conversion (opus), upload to R2 |
| `stt` | Everything `record` does + transcription via STT engine |
| `audioPlayer` | File queue, beeps between files, key-driven controls (skip / pause / jump / restart), resume position tracking |
| `simpleRouting` / `ipRouting` | Outbound dial, ringback or hold music, call supervision, result capture (ANSWER/NOANSWER/BUSY/CHANUNAVAIL) |
| `getDTMF` | Prompt audio, multi-digit collection, min/max enforcement, optional confirmation readback (number / digits), re-prompt on bad input |
| `simpleMenu` | Prompt audio, single-key capture, retries (`times`), timeout handling, fallback (`extensionChange`) |

If a single module exists for a task, **you must use it as-is**. Do not decompose it into smaller pieces. Do not "help" it. Do not pre-prompt before it. Do not validate after it.

### What you must NEVER do

- ❌ **Never** use `getDTMF` to collect a credit card number, expiry, CVV, or ID — `creditCard` does this internally.
- ❌ **Never** call a payment processor (Nedarim Plus or any other) from your server. `creditCard` is the only path to charging.
- ❌ **Never** chain modules to "build" a payment flow — one `creditCard` JSON object **is** the entire payment flow.
- ❌ **Never** use `record` to capture a card number — there is no scenario where you collect card data yourself.
- ❌ **Never** play a "please enter your card number" prompt with `simpleMessage` before `creditCard` — `creditCard` already plays all its own prompts.
- ❌ **Never** wrap a module's result in your own validation prompt to the caller — let the module's own validation run.
- ❌ **Never** assume you need to "ask the caller again" if a value seems wrong — return the next module and let the PBX prompt.

### Mistaken pattern (DO NOT GENERATE THIS)

```json
[
  { "type": "simpleMessage", "files": [{ "text": "Please enter your card number." }] },
  { "type": "getDTMF", "name": "card",   "max": 16 },
  { "type": "getDTMF", "name": "expiry", "max": 4  },
  { "type": "getDTMF", "name": "cvv",    "max": 4  },
  { "type": "getDTMF", "name": "tz",     "max": 9  }
]
```

This is **wrong**. It tries to collect card data on your server, which (a) is a PCI violation, (b) cannot actually charge anything because your server has no processor connection, and (c) duplicates work the `creditCard` module already does.

### Correct pattern

```json
{
  "type": "creditCard",
  "name": "payment",
  "sum": 250,
  "cvv": "yes",
  "tz": "yes"
}
```

That's the entire payment. The PBX prompts for everything, charges the card, and tells the caller the result. Your next request from the PBX will arrive with `&payment=OK&CONFIRM_payment=12345678`.

### Decision rule for AI generators

Before generating any module sequence, ask yourself for each step:

> *"Is there a single existing module that already does this whole step?"*

If yes — use that one module. Do not decompose. Do not chain. Do not pre-/post-process.

In particular: **any task involving a credit card payment is always exactly one `creditCard` module — never more, never less.**

### Language — Hebrew is the default; other languages also work

The system is built around Hebrew, but `text` fields are not restricted to Hebrew — the TTS engines support multiple languages and will read whatever you send.

**Practical guidance:**

- **Default to Hebrew** unless the caller is known to prefer another language. Most callers reaching this PBX expect Hebrew prompts.
- **Match the language to the script the user gave you.** If the call script you were asked to implement is in Hebrew, keep it in Hebrew — do not translate to English. If it is in English (or any other language), keep it as-is.
- **Don't mix languages awkwardly inside one prompt.** The TTS will read each word using the phonetics of the chosen voice — short embedded numbers and currency are fine, but long English phrases inside a Hebrew sentence (or vice versa) sound unnatural.

The default voice `he-IL-Standard-D` is a Hebrew speaker — best results with Hebrew text. The Gemini voices (`Charon`, `Kore`, etc.) handle multiple languages; the character labels ("Cheerful", "Firm", "Mature") describe tonal style only.

**Hebrew prompt — typical:**
```json
{ "text": "להקשת תרומה, הקש 1. לתמיכה, הקש 2." }
```

**English prompt — also valid when the script calls for it:**
```json
{ "text": "Press 1 to donate, 2 for support." }
```

### The PBX accumulates `name` values automatically — your server is stateless

> ⚠️ **Critical for AI generators:** do **not** generate code that stores per-call state in a database, Redis, or files just to track call progress. The PBX already does that for you, in the URL.

Every time your server returns a module that produces a `name` value (e.g. `getDTMF`, `simpleMenu`, `record`, `creditCard`), the PBX appends the result to the URL of every **subsequent** request **within the same api extension**. The accumulation continues for the entire api extension — params from round-trip 1 are still in the URL of round-trip 5.

Concretely: if the caller pressed `1` for a menu, then entered `250` as an amount, then completed a credit card charge — the request that arrives **after** the charge contains all three results:

```
GET /ivr?PBXcallId=a1b2c3&PBXcallStatus=CALL
       &menuChoice=1&amount=250&payment=OK&CONFIRM_payment=12345678
```

Your handler can derive *"which step is the call on?"* purely by inspecting which params are present in `$_GET`. No DB, no Redis, no in-memory map.

```php
if (isset($_GET['payment']))         { /* charge finished — handle result */ }
elseif (isset($_GET['amount']))      { /* amount entered — return creditCard */ }
elseif (isset($_GET['menuChoice']))  { /* menu chosen — return amount prompt */ }
else                                 { /* fresh call — return initial menu */ }
```

This is the canonical pattern. **The PBX is the state machine. Your server is a stateless decision function.**

#### When you DO want server-side memory

A few scenarios where keying by `PBXcallId` to a database is genuinely useful — none of them are required for call-flow control:

- **External lookups you don't want to repeat** — e.g., on round-trip 1 you fetch the caller's account from a CRM; cache it under `PBXcallId` so subsequent requests don't refetch.
- **Cross-call business logic** — e.g., *"this caller already donated today"* (keyed by phone number, persisted long-term).
- **Logging and analytics** — recording the call's path for later review.
- **Idempotency** — if your handler can be retried.

For everything else, read from `$_GET`.

#### `fixed: "yes"` — survive `goTo` across extensions

The accumulating params live inside a single api extension's loop. When the call jumps via `goTo` to a **different** api extension, the accumulated params are dropped — the new extension starts with a clean URL.

To carry a value across that boundary, set `fixed: "yes"` on the module that produced it. From that point on, those result params are attached to **every subsequent request for the rest of the call**, including across `goTo` jumps to other api extensions.

> If your entire flow lives inside one api extension (which is the typical case), you do **not** need `fixed: "yes"`. The auto-accumulation already covers you.

### Chaining vs. splitting — when arrays are allowed

You may chain modules into a single response array **only when the next module does not depend on the result of the previous one.** Chaining runs the modules in order and returns *all* their result params in **one** subsequent request.

If the next module's parameters depend on a previous module's result — for example, *"collect a digit, and if it's 1 charge ₪50, if it's 2 charge ₪100"* — you **must split** into separate round-trips. The PBX cannot run conditional logic in your stead.

**OK to chain (no branching):**
```json
[
  { "type": "getDTMF", "name": "id",    "max": 9,  "files": [{ "text": "ת.ז." }] },
  { "type": "getDTMF", "name": "phone", "max": 10, "files": [{ "text": "טלפון" }] },
  { "type": "simpleMessage", "files": [{ "text": "תודה" }] }
]
```

**NOT OK to chain (branching needed — the `sum` depends on `choice`):**
```json
[
  { "type": "simpleMenu", "name": "choice", "enabledKeys": "1,2", "files": [...] },
  { "type": "creditCard", "name": "pay", "sum": "???" }
]
```

For the second case, return the `simpleMenu` alone, wait for the next request with `&choice=1` or `&choice=2`, then return the `creditCard` with the right `sum`.

> **`name` collision rule:** never reuse the same `name` value across modules in a single chain. The PBX returns all results as query parameters with the names you set, and duplicates overwrite each other. Use distinct names (`amount1`, `amount2`, etc.).

### Modules exposed via this API — this is the complete list

The modules documented in this file are the **entire** set callable via the API. The PBX has additional internal modules (voicemail, queue routing, mailing list management, conferencing, etc.) — but those are configured through the PBX admin interface and **cannot** be returned as a JSON response from your server.

If you need behavior beyond the modules in this doc, the only API-level option is to redirect the caller to a pre-configured extension using `goTo`.

---

## Fixed Parameters

The PBX appends these parameters to every request automatically:

| Parameter | Description |
|---|---|
| `PBXphone` | Caller's phone number |
| `PBXnum` | PBX phone number |
| `PBXdid` | Dialed number (relevant when the PBX has multiple access numbers) |
| `PBXcallId` | Unique call identifier — constant throughout the entire call |
| `PBXcallType` | `in` = inbound call, `out` = outbound / campaign |
| `PBXcallStatus` | `CALL` = active, `HANGUP` = disconnected |
| `PBXextensionId` | Current extension ID |
| `PBXextensionPath` | Extension path (hierarchy) |

> **Tip:** `HANGUP` is sent after the call ends — use it for cleanup, logging, or post-call workflows.

### Template substitution — `{{PBXparam}}` inside module fields

Inside string fields of any module (notably `fileName` in `record` / `stt`), you can reference any of the fixed parameters above by wrapping its name in double curly braces. The PBX substitutes the live value at execution time.

| Template | Resolves to |
|---|---|
| `{{PBXphone}}` | The caller's phone number |
| `{{PBXcallId}}` | The unique call identifier |
| `{{PBXdid}}` | The DID number that was dialed |
| `{{PBXnum}}` | The PBX phone number |
| `{{PBXextensionId}}` | Current extension ID |

**Example — unique recording filename per caller per call:**
```json
{ "type": "record", "name": "rec", "fileName": "msg_{{PBXphone}}_{{PBXcallId}}" }
```

> Templates work only in module **string fields you set in the response**, not in caller-facing `text` (TTS won't substitute).

---

## Response Format

**Single module:**

```json
{
  "type": "<module_type>",
  "name": "<param_name>",
  ...
}
```

**Chained modules (array):**

```json
[
  { "type": "...", "name": "...", ... },
  { "type": "...", "name": "...", ... }
]
```

---

## Modules

---

### `simpleMessage`

Plays audio content and immediately moves to the next command. **No input, no return value.**

| Parameter | Required | Description |
|---|---|---|
| `type` | ✅ | `"simpleMessage"` |
| `files` | ✅ | Array of audio items to play |

Playback rules are identical to `simpleMenu` — all file types are supported.

**Example:**

```json
{
  "type": "simpleMessage",
  "files": [
    { "text": "Thank you for calling. An agent will get back to you shortly." }
  ]
}
```

> No response is sent back to your server. The PBX plays the audio and proceeds to the next command in the chain, or makes a new request if no more commands remain.

---

### `simpleMenu`

Plays audio and waits for the caller to press **a single key** from a predefined list.

| Parameter | Required | Default | Description |
|---|---|---|---|
| `type` | ✅ | — | `"simpleMenu"` |
| `name` | ✅ | — | Parameter name returned with the keypress |
| `enabledKeys` | ✅ | — | Allowed keys, comma-separated. e.g. `"1,2,3,*,#"` |
| `times` | ❌ | — | How many times to repeat before returning an error |
| `timeout` | ❌ | — | Seconds to wait for a keypress before repeating |
| `errorReturn` | ❌ | `"ERROR"` | Value returned on timeout |
| `extensionChange` | ❌ | — | Where to go after exhausting `times`: extension ID / `"."` (current) / `".."` (previous) |
| `setMusic` | ❌ | `"no"` | `"yes"` to play hold music while waiting for your server response |
| `files` | ❌ | — | Audio items to play |

> Pressing a key not listed in `enabledKeys` is ignored — the caller keeps waiting.

**Example:**

```json
{
  "type": "simpleMenu",
  "name": "menuChoice",
  "times": 3,
  "timeout": 5,
  "enabledKeys": "1,2,3",
  "extensionChange": "..",
  "files": [
    { "text": "Press 1 for sales, 2 for support, 3 for billing." }
  ]
}
```

**Response:** `?...&menuChoice=2` or `&menuChoice=ERROR`

---

### `getDTMF`

Plays audio and collects a **multi-digit sequence** from the caller.

| Parameter | Required | Description |
|---|---|---|
| `type` | ✅ | `"getDTMF"` |
| `name` | ✅ | Parameter name returned with the input |
| `max` | ✅ | Maximum number of digits |
| `min` | ❌ | Minimum digits — if fewer entered, prompts again |
| `timeout` | ❌ | Seconds between digits |
| `skipKey` | ❌ | Key to finish input early (e.g. `"#"`) |
| `skipValue` | ❌ | Value sent if `skipKey` is pressed with no prior input |
| `confirmType` | ❌ | `"number"` (default) / `"digits"` / `"no"` |
| `setMusic` | ❌ | `"yes"` / `"no"` |
| `files` | ❌ | Audio items to play before collecting input |

**`confirmType` values:**
- `number` — reads back the input as a whole number ("one hundred twenty-three")
- `digits` — reads back digit by digit ("one two three")
- `no` — no readback, no confirmation prompt

**Example:**

```json
{
  "type": "getDTMF",
  "name": "idNumber",
  "max": 9,
  "min": 5,
  "timeout": 5,
  "skipKey": "#",
  "skipValue": "SKIP",
  "confirmType": "digits",
  "files": [
    { "text": "Please enter your ID number." }
  ]
}
```

**Response:** `?...&idNumber=123456789` or `&idNumber=SKIP`

---

### `record`

Records a voice message and saves it as an audio file.

| Parameter | Required | Description |
|---|---|---|
| `type` | ✅ | `"record"` |
| `name` | ✅ | Base name for all returned parameters |
| `max` | ❌ | Maximum recording duration in seconds |
| `min` | ❌ | Minimum recording duration in seconds |
| `confirm` | ❌ | `"confirmOnly"` (default) / `"ful"` / `"no"` |
| `fileName` | ❌ | File name to save in the system |
| `saveFolder` | ❌ | Extension ID to save in a different folder |
| `files` | ❌ | Audio items to play before recording |

**`confirm` values:**
- `confirmOnly` — ask for confirmation, option to replay by pressing `2`
- `ful` — play back the recording, then ask for confirmation
- `no` — save immediately without confirmation

**Example:**

```json
{
  "type": "record",
  "name": "rec",
  "max": 30,
  "min": 2,
  "confirm": "confirmOnly",
  "fileName": "msg_{{PBXphone}}",
  "files": [
    { "text": "Please leave a message after the beep." }
  ]
}
```

See [record & stt Response Parameters](#record--stt-response-parameters) for returned values.

---

### `stt` — Speech to Text

Records the caller and returns a **text transcription**.

> **Cost:** 0.25 units per 10 seconds. **Maximum recording: 10 seconds.**

| Parameter | Required | Description |
|---|---|---|
| `type` | ✅ | `"stt"` |
| `name` | ✅ | Base name for all returned parameters |
| `max` | ❌ | Maximum seconds (up to 10) |
| `min` | ❌ | Minimum seconds |
| `fileName` | ❌ | File name to save |
| `saveFolder` | ❌ | Extension ID for storage folder |
| `campaignBilling` | ❌ | Campaign ID for billing tracking |
| `files` | ❌ | Audio items to play before recording |

**Example:**

```json
{
  "type": "stt",
  "name": "spoken",
  "max": 8,
  "files": [
    { "text": "Please say your name after the beep." }
  ]
}
```

See [record & stt Response Parameters](#record--stt-response-parameters) for returned values.
The primary `spoken` parameter contains the transcribed text string.

---

### `simpleRouting`

Transfers the call to an Israeli phone number (mobile or landline).

> **Israeli phone number format:** `dialPhone` must be a full Israeli number with leading `0` and **no** country code, no `+`, no dashes, no spaces. E.g. `0501234567` (mobile) or `0312345678` (landline).
>
> Same format applies to `displayNumber`.

| Parameter | Required | Description |
|---|---|---|
| `type` | ✅ | `"simpleRouting"` |
| `name` | ✅ | Parameter name returned with the call status |
| `dialPhone` | ✅ | Israeli phone number to dial (format above) |
| `displayNumber` | ❌ | Number shown to the recipient on caller-ID. Empty string = pass through the original caller's number. |
| `addDigits` | ❌ | Digits appended to the caller's phone number when displayed at the destination — used by the receiving side to identify the source IVR / extension / campaign. Most flows leave this empty. |
| `routingMusic` | ❌ | `"yes"` = play hold music to the caller during dial / `"no"` = play standard ringing tone |
| `ringSec` | ❌ | Ring duration in seconds before giving up and returning `NOANSWER` |
| `limit` | ❌ | Maximum call duration in seconds (after answer). Empty = no limit. |
| `campaignBilling` | ❌ | Campaign ID. When set, the cost of this outbound leg is charged to that campaign's billing account instead of the default. Empty = normal billing. |

**Example:**

```json
{
  "type": "simpleRouting",
  "name": "callResult",
  "dialPhone": "0501234567",
  "displayNumber": "",
  "addDigits": "001",
  "routingMusic": "yes",
  "ringSec": 20,
  "limit": ""
}
```

---

### `ipRouting`

Transfers the call to a SIP/IP extension.

| Parameter | Required | Description |
|---|---|---|
| `type` | ✅ | `"ipRouting"` |
| `name` | ✅ | Parameter name returned with the call status |
| `dialPhone` | ✅ | Extension number to dial |
| `dialIP` | ✅ | Destination IP address |
| `displayNumber` | ❌ | Number shown to the recipient |
| `routingMusic` | ❌ | `"yes"` / `"no"` |
| `ringSec` | ❌ | Ring duration in seconds |
| `limit` | ❌ | Maximum call duration in seconds |

**Example:**

```json
{
  "type": "ipRouting",
  "name": "dial",
  "dialPhone": "105",
  "dialIP": "192.168.1.100",
  "displayNumber": "",
  "routingMusic": "yes",
  "ringSec": 15,
  "limit": ""
}
```

---

### `audioPlayer`

Plays audio files in sequence and returns detailed listening data.

> **Resume playback:** Save the `startSecond` value returned and send it in the next request to resume from where the caller stopped.

| Parameter | Required | Description |
|---|---|---|
| `type` | ✅ | `"audioPlayer"` |
| `name` | ✅ | Parameter name for the result |
| `files` | ✅ | Audio files to play |
| `startFile` | ❌ | File index to start from (1-based) |
| `startSecond` | ❌ | Start position in milliseconds (1000 = 1 second) |
| `beepPlay` | ❌ | `"YES"` (default) / `"NO"` — beep between files |
| `playLength` | ❌ | `"YES"` / `"NO"` (default) — announce file duration |
| `digitsSource` | ❌ | `"template"` / other value |
| `playTemplate` | ❌ | Key mapping template ID (used with `digitsSource: "template"`) |

**Example — resume from last position:**

```json
{
  "type": "audioPlayer",
  "name": "listenResult",
  "startFile": 1,
  "startSecond": 45000,
  "beepPlay": "NO",
  "files": [
    { "fileId": "1001" },
    { "fileId": "1002" }
  ]
}
```

---

### `goTo`

Transfers the call to another extension within the PBX.

| Parameter | Required | Description |
|---|---|---|
| `type` | ✅ | `"goTo"` |
| `goTo` | ✅ | Target extension ID |

**Example:**

```json
{
  "type": "goTo",
  "goTo": "1234"
}
```

---

### `hangup`

Immediately disconnects the call.

```json
{
  "type": "hangup"
}
```

#### After hangup — the final HANGUP request

When the call ends — whether triggered by this module, by the caller hanging up, by call timeout, or any other reason — the PBX sends **one final request** to your server with `PBXcallStatus=HANGUP`.

> ## ⚠️ How your server must respond to a HANGUP request
>
> Return an **empty `200 OK`** (or `{}`). **Do NOT return a module** — there is no caller anymore, so any module you return is wasted (and may produce errors on the PBX side).
>
> Detect HANGUP at the **very top** of your handler and short-circuit:
>
> ```php
> if (($_GET['PBXcallStatus'] ?? '') === 'HANGUP') {
>     // optional post-call work
>     http_response_code(200);
>     exit;
> }
> ```

The HANGUP request still carries the full set of accumulated params from the call (`menuChoice`, `amount`, `payment`, `CONFIRM_payment`, etc.) — so you have everything you need for post-call work right there in `$_GET`.

Use the HANGUP request for things like:
- Logging the final outcome of the call (status, duration, collected data)
- Persisting business data your server cares about (e.g. donation records)
- Cleaning up any optional per-call cache you set up under `PBXcallId`
- Sending post-call notifications (email, SMS, webhooks to other systems)

---

### `creditCard`

> ## 🛑 STOP — READ BEFORE GENERATING
>
> `creditCard` is a **self-contained, end-to-end payment module**. When your server returns this single JSON object, the PBX itself runs the **entire** payment interaction with the caller:
>
> 1. Optionally announces / confirms the amount in Hebrew
> 2. Prompts the caller for the **card number** (9–16 digits) and collects it
> 3. Prompts for the **expiry date** (MMYY), validates it, re-prompts if expired
> 4. Prompts for the **CVV** (if `cvv="yes"`) and collects it
> 5. Prompts for the **ID number** (if `tz="yes"`) and collects it
> 6. Prompts for **installments** (if `payments>1`) and collects the choice
> 7. **Submits the transaction to Nedarim Plus** over a secure backend channel
> 8. Announces the result (approval / decline) and the confirmation number to the caller
> 9. Offers an end menu (`1` = charge again, `*#0` = exit)
>
> **Your server's only job: return this one JSON object with the right parameters.**
>
> You do **NOT**:
> - Collect any card data with `getDTMF`, `record`, or any other module
> - Call Nedarim Plus or any other processor from your server
> - Chain modules to assemble a payment flow
> - Play introductory prompts before this module — it has its own prompts
> - Process or validate the result before passing it to the caller — the PBX already announced it
>
> If the task is *"charge the caller X shekels"*, the answer is **always exactly one `creditCard` module**. Never more, never less. Never wrapped in `simpleMessage` / `getDTMF` / `record`.
>
> The result (`OK` / `ERROR` / processor status + confirmation number) arrives on the **next** PBX request to your server, as query parameters under the `name` you set.

Charges a credit card mid-call against the payment processor (Nedarim Plus). Collects card details from the caller (PAN, expiry, optional CVV / ID / installments), submits the transaction, and returns the result (status + confirmation number) on the next request to your server.

> **Security:** Full PAN, CVV, and ID are **never stored**. Only the last 4 digits, expiry, amount, status, and confirmation number are persisted — for every attempt, including failures.

#### System Fields

| Parameter | Required | Description |
|---|---|---|
| `type` | ✅ | `"creditCard"` |
| `name` | ✅ | Logical name. Final status and confirmation number are returned under this name |
| `fixed` | ❌ | `"yes"` = the result params (`<name>` and `CONFIRM_<name>`) survive a `goTo` to another api extension and remain attached to every subsequent request for the rest of the call. **Within a single api extension you do not need this** — the PBX already accumulates all module results in every request automatically. Set `"yes"` only when the call may jump to a different api extension that still needs to see the payment result. Default `"no"`. |

#### Transaction Parameters

| Parameter | Default | Description |
|---|---|---|
| `sum` | `0` | Amount to charge. `0` = prompt the caller to enter the amount |
| `sumChangeable` | `"no"` | `"yes"` = announce the amount and require confirmation (`1` = approve, `*0` = cancel) |
| `cvv` | `"yes"` | `"yes"` = ask for 3-4 digit CVV |
| `tz` | `"yes"` | `"yes"` = ask for ID number (6-9 digits) |
| `payments` | `1` | Maximum installments. `1` = don't ask. `>1` = prompt for 1..X |
| `category` | `""` | Free-text category sent to the processor (Hebrew supported) |
| `terminal` | `""` | Processor terminal ID |

#### Audio Flags (optional — control what the caller hears)

| Parameter | If `"yes"` |
|---|---|
| `noSum` | Suppress "the amount is X" announcement (only when `sumChangeable="no"`) |
| `noSuccess` | Suppress "transaction approved" announcement |
| `noConfirmation` | Suppress "confirmation number is X" + digit readback |
| `noFailExit` | **On failure, do not exit the module** — loop back to ask for card details again, indefinitely. **No exit key.** |

> **⚠️ `noFailExit="yes"` is dangerous:** the caller is trapped until the transaction succeeds or they hang up. Use only when the call cannot continue without a successful charge.

#### Call Flow

1. Announce / confirm amount (if applicable)
2. Prompt for card number (9-16 digits)
3. Prompt for expiry (4 digits, MMYY) — validated, re-prompted if expired
4. CVV — if `cvv="yes"`
5. ID number — if `tz="yes"`
6. Installments — if `payments>1`
7. Submit to processor
8. **Success:** approval audio + confirmation number + end menu (`1` = charge again, `*#0` = exit)
9. **Failure:** error message. If `noFailExit="yes"`, return to step 2; otherwise exit the module

#### Example

```json
{
  "type": "creditCard",
  "name": "payment",
  "sum": 250,
  "sumChangeable": "no",
  "cvv": "yes",
  "tz": "yes",
  "payments": 3,
  "category": "Donation",
  "terminal": "0001",
  "noSum": "no",
  "noSuccess": "no",
  "noConfirmation": "no",
  "noFailExit": "no"
}
```

#### Response (next request to your server)

Given `"name": "payment"`:

| Parameter | Value |
|---|---|
| `payment` | `OK` / `ERROR` / status from processor (e.g. `DECLINE`) |
| `CONFIRM_payment` | Confirmation number (empty on failure) |

```
?...&payment=OK&CONFIRM_payment=12345678&...
```

**Status values:**

| Value | Meaning |
|---|---|
| `OK` | Transaction approved |
| `ERROR` | Caller cancelled (`*` / `0`), hung up, or general failure |
| Other | Status returned directly by the processor (e.g. `DECLINE`) |

> **Automatic logging:** every attempt (success or failure) is recorded with status, confirmation number, amount, installments, last-4 digits, expiry, and the full module JSON. Full PAN / CVV / ID are **not** stored.

---

## The `files` Object

Any module that supports audio playback accepts a `files` array. Different types can be mixed in the same array.

### Content Types

| Type | Field | Example |
|---|---|---|
| Existing file by ID | `fileId` | `{ "fileId": "1234" }` |
| Existing file by name | `fileName` | `{ "fileName": "welcome" }` |
| Text-to-speech | `text` | `{ "text": "Hello, welcome." }` |
| Number (spoken as whole) | `number` | `{ "number": "123" }` → "one hundred twenty-three" |
| Digits (spoken individually) | `digits` | `{ "digits": "123" }` → "one two three" |
| External URL | `fileLink` + `fileName` | `{ "fileLink": "https://...", "fileName": "audio_v1" }` |

> ### 💡 Tip — keep TTS `text` segments short (faster + cheaper)
>
> Each unique `text` value is synthesized **once** by the TTS engine and then cached. Subsequent playbacks of the **exact same** string are served from cache — **instantly and at no extra cost** (relevant especially for paid Gemini voices, which are billed per synthesis).
>
> **Practical rule:** split long prompts into many short, **reusable** text items rather than one long paragraph. Reuse the same phrasing across calls and across your whole IVR.
>
> **❌ Less efficient — one long unique block:**
> ```json
> "files": [
>   { "text": "ברוכים הבאים לחברת ABC. להזמנה חדשה הקישו 1, לבירור על הזמנה קיימת הקישו 2, לדיבור עם נציג הקישו 3, לסיום השיחה הקישו 9." }
> ]
> ```
> Every variation of the menu re-synthesizes the entire paragraph — slow and (on paid voices) re-billed every time.
>
> **✅ Better — short reusable chunks:**
> ```json
> "files": [
>   { "text": "ברוכים הבאים לחברת ABC." },
>   { "text": "להזמנה חדשה הקישו 1." },
>   { "text": "לבירור על הזמנה קיימת הקישו 2." },
>   { "text": "לדיבור עם נציג הקישו 3." },
>   { "text": "לסיום השיחה הקישו 9." }
> ]
> ```
> Each short line is cached independently. The next call (and any other menu reusing "ברוכים הבאים לחברת ABC.") plays it from cache — zero synthesis time, zero charge.
>
> **Why short matters:** even a one-character difference in a long sentence forces a full re-synthesis. Short atomic phrases are far more likely to match an existing cache entry — both within the same call flow and across unrelated flows on the same PBX.

### Additional Item Parameters

| Parameter | Applies to | Description |
|---|---|---|
| `extensionId` | `fileId` / `fileName` | Extension ID where the audio file is stored. Default: the extension currently being executed. Set this when referencing a file that lives under a *different* extension in the IVR tree. |
| `extensionPath` | `fileId` / `fileName` | Alternative to `extensionId` — the hierarchical extension path (e.g. `/100/200/300`) instead of an ID. Use one or the other, not both. |
| `activatedKeys` | `simpleMenu` only | Keys active during this specific file. Special values: `NONE` (disable all keys) / `SKIP` (any key skips to next file) |

> **External URL caching:** The system caches files for several days. If you update the file content, change `fileName` to force a fresh load.

### Voice Selection (TTS only)

Applies to items with the `text` field — controls which voice synthesizes the text.

> **All voices below speak Hebrew.** The character labels in the tables ("Cheerful", "Firm", "Mature", etc.) describe the *tonal style* of the voice — not the language. Always pass Hebrew text to any of these voices.

| Mode | How | Cost |
|---|---|---|
| **Default — Google Cloud TTS** | Omit the `voice` field (or `voice: "he-IL-Standard-D"`) | Included — no additional charge |
| **Gemini AI voices** | Add `voice: "<voice_name>"` from the table below | **Paid add-on** — billed per use |

```json
{ "text": "ברוכים הבאים לקו השירות.", "voice": "Charon" }
```

> The `voice` field is ignored on non-text items (`fileId`, `fileName`, `fileLink`, `number`, `digits`).

#### Valid `voice` values

**Default (Google Cloud TTS — free):**

| `voice` | Description |
|---|---|
| `he-IL-Standard-D` | Google standard Hebrew voice (default if `voice` is omitted) |

**Gemini AI — Male voices (16) — paid:**

| `voice` | Character |
|---|---|
| `Charon` | Informative |
| `Puck` | Cheerful |
| `Fenrir` | Energetic |
| `Orus` | Firm |
| `Enceladus` | Soft |
| `Iapetus` | Clear |
| `Umbriel` | Calm |
| `Algieba` | Smooth |
| `Algenib` | Gravelly |
| `Rasalgethi` | Informative |
| `Alnilam` | Firm |
| `Schedar` | Balanced |
| `Achird` | Friendly |
| `Zubenelgenubi` | Casual |
| `Sadachbia` | Lively |
| `Sadaltager` | Knowledgeable |

**Gemini AI — Female voices (14) — paid:**

| `voice` | Character |
|---|---|
| `Kore` | Firm |
| `Zephyr` | Bright |
| `Leda` | Youthful |
| `Aoede` | Breezy |
| `Callirrhoe` | Easy-going |
| `Autonoe` | Bright |
| `Despina` | Smooth |
| `Erinome` | Clear |
| `Laomedeia` | Upbeat |
| `Achernar` | Soft |
| `Gacrux` | Mature |
| `Pulcherrima` | Forward |
| `Vindemiatrix` | Gentle |
| `Sulafat` | Warm |

---

### Full Example

```json
"files": [
  { "text": "Welcome." },
  { "text": "Pay attention to the next message.", "voice": "Charon" },
  { "fileId": "500", "extensionId": "" },
  { "digits": "1234" },
  { "text": "Press 1 to confirm.", "activatedKeys": "1" }
]
```

---

## Chaining Commands

Send an array of modules to execute them in sequence. All results are returned together in a single request to your server.

**Example — collect ID, phone, and confirmation in one round-trip:**

```json
[
  {
    "type": "getDTMF",
    "name": "idNumber",
    "max": 9,
    "files": [{ "text": "Enter your ID number." }]
  },
  {
    "type": "getDTMF",
    "name": "phone",
    "max": 10,
    "files": [{ "text": "Enter your phone number." }]
  },
  {
    "type": "simpleMenu",
    "name": "confirm",
    "enabledKeys": "1,2",
    "files": [{ "text": "Press 1 to confirm, 2 to cancel." }]
  }
]
```

**Single response with all values:**

```
?...&idNumber=123456789&phone=0501234567&confirm=1
```

---

## `record` & `stt` Response Parameters

Both modules return multiple parameters based on the `name` you defined.

Given `"name": "rec"`:

| Parameter | Value |
|---|---|
| `rec` | Primary value — file name (`record`) or transcribed text (`stt`) |
| `FILE_rec` | File name |
| `PATH_rec` | Full file path |
| `SIZE_rec` | File size in MB |
| `DURATION_rec` | Duration in seconds |
| `DIGIT_rec` | Key pressed to confirm |

---

## Full Worked Example — Donation Flow

Five round-trips run an entire donation-with-payment call. Read this **before** writing any code — most call flows follow exactly this pattern.

**Scenario:** A caller dials in. They hear a menu. If they choose to donate, they enter an amount, the system charges their credit card, then thanks them and hangs up.

### Server skeleton — fully stateless

Because the PBX accumulates every previous `name` value into every subsequent request, the server does not need to store anything between requests. The presence (or absence) of params in `$_GET` tells the handler exactly which step the call is on.

```php
<?php
header('Content-Type: application/json; charset=utf-8');

// 1. HANGUP request → no caller, no module to return
if (($_GET['PBXcallStatus'] ?? '') === 'HANGUP') {
    finalizeCall($_GET);   // optional: log / persist / notify external systems
    http_response_code(200);
    exit;
}

// 2. Decide the next module based ONLY on what's in $_GET
$response = null;

if (isset($_GET['payment'])) {
    // Charge has finished. The result is in $_GET['payment'].
    if ($_GET['payment'] === 'OK') {
        $response = [
            ['type' => 'simpleMessage', 'files' => [['text' => 'תודה רבה על תרומתך.']]],
            ['type' => 'hangup'],
        ];
    } else {
        $response = [
            ['type' => 'simpleMessage', 'files' => [['text' => 'הסליקה לא הצליחה. נציג יחזור אליך.']]],
            ['type' => 'hangup'],
        ];
    }
}
elseif (isset($_GET['amount'])) {
    // Amount entered → kick off the credit-card module
    $response = [
        'type'          => 'creditCard',
        'name'          => 'payment',
        'sum'           => (int) $_GET['amount'],
        'sumChangeable' => 'no',
        'cvv'           => 'yes',
        'tz'            => 'yes',
        'payments'      => 1,
        'category'      => 'תרומה',
    ];
}
elseif (isset($_GET['menuChoice'])) {
    // Menu chosen → ask for the donation amount
    $response = [
        'type'        => 'getDTMF',
        'name'        => 'amount',
        'max'         => 5,
        'min'         => 1,
        'timeout'     => 5,
        'skipKey'     => '#',
        'confirmType' => 'number',
        'files'       => [['text' => 'אנא הזן את סכום התרומה בשקלים, ובסיום לחץ סולמית.']],
    ];
}
else {
    // Fresh call — show the initial menu
    $response = [
        'type'            => 'simpleMenu',
        'name'            => 'menuChoice',
        'enabledKeys'     => '1,2,3',
        'times'           => 3,
        'timeout'         => 5,
        'extensionChange' => '..',
        'files'           => [['text' => 'ברוכים הבאים. לתרומה הקש 1, לבירור הקש 2, לסיום הקש 3.']],
    ];
}

echo json_encode($response, JSON_UNESCAPED_UNICODE);
```

No `loadState`, no `saveState`, no database key — `$_GET` carries everything you need.

The five round-trips below show what the PBX sends and what the handler returns at each step.

---

### Round-trip 1 — Initial request (call started)

**PBX → server:**
```
GET /ivr?PBXphone=0501234567&PBXcallId=a1b2c3&PBXcallStatus=CALL
       &PBXextensionId=100&PBXcallType=in
```

**Handler logic:** none of `payment` / `amount` / `menuChoice` is present → fresh call → return the menu.

**Server → PBX:**
```json
{
  "type": "simpleMenu",
  "name": "menuChoice",
  "enabledKeys": "1,2,3",
  "times": 3,
  "timeout": 5,
  "extensionChange": "..",
  "files": [
    { "text": "ברוכים הבאים. לתרומה הקש 1, לבירור הקש 2, לסיום הקש 3." }
  ]
}
```

The PBX plays the prompt, captures one keypress, then sends round-trip 2.

---

### Round-trip 2 — Caller pressed `1` (donate)

**PBX → server (note: `menuChoice` now in URL):**
```
GET /ivr?PBXcallId=a1b2c3&PBXcallStatus=CALL&menuChoice=1&...
```

**Handler logic:** `menuChoice` is present, `amount` and `payment` are not → ask for the donation amount.

**Server → PBX:**
```json
{
  "type": "getDTMF",
  "name": "amount",
  "max": 5,
  "min": 1,
  "timeout": 5,
  "skipKey": "#",
  "confirmType": "number",
  "files": [
    { "text": "אנא הזן את סכום התרומה בשקלים, ובסיום לחץ סולמית." }
  ]
}
```

> We do **not** chain `creditCard` here — its `sum` depends on the result of this `getDTMF`, which we don't have yet.

---

### Round-trip 3 — Caller entered `250`

**PBX → server (note: both `menuChoice` and `amount` are in URL — they accumulate):**
```
GET /ivr?PBXcallId=a1b2c3&PBXcallStatus=CALL&menuChoice=1&amount=250&...
```

**Handler logic:** `amount` is present, `payment` is not → return `creditCard` with `sum` taken from `$_GET['amount']`.

**Server → PBX:**
```json
{
  "type": "creditCard",
  "name": "payment",
  "sum": 250,
  "sumChangeable": "no",
  "cvv": "yes",
  "tz": "yes",
  "payments": 1,
  "category": "תרומה"
}
```

> The server returns only the `creditCard` module. From here, the PBX runs the entire payment internally. The server is silent until round-trip 4.

---

### Round-trip 4 — Charge succeeded

**PBX → server (all prior params + the new `payment` result):**
```
GET /ivr?PBXcallId=a1b2c3&PBXcallStatus=CALL
       &menuChoice=1&amount=250&payment=OK&CONFIRM_payment=12345678&...
```

**Handler logic:** `payment` is present and equals `OK` → return thank-you + hangup.

**Server → PBX (chained — both modules always run together when payment is OK):**
```json
[
  {
    "type": "simpleMessage",
    "files": [
      { "text": "תודה רבה על תרומתך. אישור התרומה יישלח אליך בהקדם." }
    ]
  },
  { "type": "hangup" }
]
```

> Branching note: had `payment` been anything other than `OK` (e.g. `DECLINE` or `ERROR`), the handler's `if` block returns a different message. That's exactly **why** we don't chain `creditCard` together with the thank-you message in round-trip 3 — we don't yet know which branch to take.

---

### Round-trip 5 — Final HANGUP

**PBX → server:**
```
GET /ivr?PBXcallId=a1b2c3&PBXcallStatus=HANGUP&...&menuChoice=1&amount=250&payment=OK&CONFIRM_payment=12345678
```

**Handler logic:** `PBXcallStatus=HANGUP` is detected at the very top → optionally log the final outcome (the URL still carries the full picture: phone, amount, payment, confirmation), then return empty `200 OK`.

**No JSON body. No module returned.**

---

### Round-trip summary

| # | PBX brought (cumulative params) | Server returned |
|---|---|---|
| 1 | (none yet) | `simpleMenu` (donate / status / exit) |
| 2 | `menuChoice=1` | `getDTMF` (amount) |
| 3 | `menuChoice=1`, `amount=250` | `creditCard` (sum=250) |
| 4 | `menuChoice=1`, `amount=250`, `payment=OK`, `CONFIRM_payment=12345678` | `[simpleMessage, hangup]` |
| 5 | all of the above + `PBXcallStatus=HANGUP` | empty `200 OK` |

**Patterns to internalize from this example:**

1. **One module per round-trip when there's branching.** Round-trips 1, 2, and 3 each return a single module because the next decision depends on this round-trip's result.
2. **Chain only when there's no branching.** Round-trip 4 chains `simpleMessage + hangup` because they always run together once `payment=OK` is confirmed.
3. **The PBX is the state machine.** Every round-trip arrives with the full history of `name` values in the URL — the server inspects `$_GET` and decides what's next. No DB / Redis / cache needed for call-flow control.
4. **HANGUP is short-circuited.** The handler detects `PBXcallStatus=HANGUP` at the top and exits before any module logic runs.
5. **Languages match the script.** This example is in Hebrew because that's the typical case — but the same handler structure works for any language the script calls for.

---

## Quick Reference

| Module | `type` | What the PBX runs internally (you do not replicate) | What you send | What you get back |
|---|---|---|---|---|
| Simple message | `simpleMessage` | Plays audio | Files to play | Nothing |
| Simple menu | `simpleMenu` | Plays audio + captures one key + retries | Files + allowed keys | Key pressed |
| Get DTMF | `getDTMF` | Plays audio + captures multi-digit input + optional confirmation readback + re-prompt on bad length | Files + min/max digits | Digits entered |
| Record | `record` | Prompt + beep + record + optional re-listen / re-record + file save | Files + duration limits | File name + duration + size |
| Speech to text | `stt` | Same as record + transcription via STT engine | Files + duration limits | Transcribed text + metadata |
| Phone routing | `simpleRouting` | Outbound dial + ringback or hold music + supervision + result capture | Destination phone | Call status |
| IP routing | `ipRouting` | Same as `simpleRouting` for SIP endpoints | Destination phone + IP | Call status |
| Audio player | `audioPlayer` | File queue + beeps + key controls (skip/pause/jump) + resume position | File list | Listening position + duration |
| Go to extension | `goTo` | Transfers to another extension | Target extension ID | Nothing |
| Hang up | `hangup` | Ends call | — | Final HANGUP request |
| **Credit card** | **`creditCard`** | **Full payment, end-to-end: amount confirm + card # + expiry (validated) + CVV + ID + installments + Nedarim Plus submission + result announcement + retry loop + end menu** | **Amount + flags only** | **Status + confirmation number** |

### "Which module do I use?" lookup

| If the task is… | Use exactly this |
|---|---|
| Play a message and continue | One `simpleMessage` |
| Ask a yes/no or 1-of-N choice (single key) | One `simpleMenu` |
| Collect a number, ID, code, phone (no card data) | One `getDTMF` |
| Capture a voice message | One `record` |
| Capture a short spoken answer as text | One `stt` |
| Transfer the call to a phone number | One `simpleRouting` |
| Transfer the call to a SIP endpoint | One `ipRouting` |
| Let the caller listen to long-form audio with controls | One `audioPlayer` |
| Jump into a different IVR extension | One `goTo` |
| End the call | One `hangup` |
| **Charge a credit card (any amount, any configuration)** | **One `creditCard` — never combine with `getDTMF` / `record` / `simpleMessage`** |

---

*Technoline PBX API — © Technoline. For support, contact Technoline customer service.*
