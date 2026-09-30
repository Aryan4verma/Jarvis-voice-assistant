# JARVIS AI boundary

`src/lib/brain.ts` is the frontend seam. The UI sends application messages and
consumes application events; it does not parse provider chunks or import SDK
message types. `shared/ai.d.mts` defines the contracts, `shared/ai.mjs` supplies
small runtime validators, and `src/lib/ai.ts` exports them to TypeScript. These
modules perform no network requests, polling, model loading, or background work.

## Contract

- `AIProviderInfo`: provider/model IDs, display name, chat/agent kind, capabilities.
- `AIMessage` / `AIRequest`: user/assistant messages containing text or base64
  images with an explicit MIME type. SDK tool-result blocks stay inside adapters.
- `AIEvent`: text deltas, tool start/activity, optional usage, done, cancellation,
  and categorized errors. UI panels, blades and camera requests retain their
  separate, existing bridge channels.
- `AIResult`: text, tool names, normalized completion reason, optional usage/error.
  Reasons include complete, max-tokens, tool-continuation, refused, cancelled,
  error and unknown. An absent/unrecognized provider stop reason stays unknown.
- `AIUsage`: optional input/output/cache token counts and optional reported or
  estimated USD cost. Missing values stay absent; missing does not mean zero.
  Direct continuation totals include only fields known for every request.
- `AIError` / `AIProviderError`: authentication, rate-limit, timeout, unavailable,
  invalid-request, model-unavailable, cancelled, network or unknown. Only safe
  adapter-owned messages, allowlisted codes, provider IDs and numeric HTTP status
  cross the boundary. Raw provider errors, headers and bodies do not.

An `AIAdapter` describes itself and implements
`generate(request, { onEvent }, interaction)`. Its `historyMode` specifies either
application messages or an internal agent session. Startup configuration problems
can be surfaced through `configurationIssue()` without a provider check in the UI.
Low-level `ask()` callback wrappers remain for existing callers/tests; the UI uses
the normalized interface.

## Current adapters

| Path | Responsibility |
| --- | --- |
| `bridge/providers/index.mjs` | Select the bridge adapter once at startup. Currently accepts only `claude-agent`; unsupported selections fail explicitly. |
| `bridge/providers/claude-agent.mjs` | Claude Agent SDK query options, stream parsing, tool deduplication/status, permission callback, session resume, images, usage/errors and SDK abort/close. One instance per connection; only a successful session ID survives a turn. |
| `bridge/server.mjs` | Authenticated transport, limits, immutable turn scope and per-turn local tool services. Delegates AI events to the adapter; adds scope/turn ID to wire events. |
| `src/lib/bridge.ts` | Transport adapter: consume normalized events, retain socket/turn guards, camera cleanup, disconnect/reconnect and timeout behavior. Provider metadata/history mode arrives on connection-scoped ready frames. |
| `src/lib/anthropic.ts` | Compatibility chat adapter for the existing direct browser Messages API path. Owns SDK types, hosted/remote tools, model options and bounded `pause_turn` continuation. |
| `shared/providers/anthropic.mjs` | Provider-specific stop/error/usage and image translation shared by these two adapters. Not part of the generic message contract. |

The bridge adapter also exposes `start()` to the host, returning a result promise
and idempotent `cancel()` receipt. Its optional per-operation runtime services
currently contain SDK MCP servers built by the host. Those service factories
(`bridge/panels.mjs`, `ui.mjs`, `vision.mjs`, `chrome.mjs`) intentionally remain
SDK-specific; this phase does not replace the tool or browser architecture.
Settings isolation (`settingSources: []`), the existing permission gate, persona,
24-turn limit and partial streaming remain intact. The permission callback is a
last gate, not a complete tool sandbox.

## Chat versus agent capabilities

Capability values are `true`, `false`, or `unknown`. The current adapters support
text and streaming. Claude Agent SDK supplies an agent runtime; direct Messages
API does not. Vision, model tool support and reasoning controls remain unknown
for arbitrary configured model IDs: no model catalog is queried and no readiness
or authentication is implied. Explicitly unsupported vision/text requests are
rejected. Unknown capability requests may be delegated to the provider and fail
with a normalized error; unknown is never advertised as supported.

A future chat adapter can stream text/images/function-call activity without
claiming MCP, filesystem execution or agent session support. Full agent behavior
requires an actual runtime/tool implementation. There is no generic tool loop or
fake Agent SDK equivalence in this foundation.

## Configuration and future adapters

`src/config.ts` exposes `AI_SELECTION` as non-secret transport/provider/model
metadata. Existing `VITE_BACKEND` selects bridge or direct. The bridge owns its
model via `JARVIS_MODEL`, effort via `JARVIS_EFFORT`, and adapter selection via
optional `JARVIS_AI_PROVIDER=claude-agent`. Defaults are preserved.

To add a future provider, implement the contract at the adapter boundary, map its
chunks/reasons/errors/usage, supply honest capabilities and register it at the
selection seam. UI message/history/TTS consumers need no provider-specific
branches. Backend adapters use the same request/events/interaction contracts and
the host operation/cancellation boundary; ordinary chat must not assume SDK MCP
services. Extend selection centrally when that provider actually exists.

The bridge can carry bounded neutral message history for a backend declaring
`historyMode: messages`; current Claude session turns still send only the latest
user content. Before metadata arrives the transport can send history, which the
Claude adapter ignores. Wire limits allow at most 32 messages, 256 KiB of total
text (32 KiB per message), and 4 MiB of total encoded image data, within the
existing WebSocket frame limit. Existing text-only request frames remain accepted.

No new provider, API-key UI or credential storage is implemented here. The legacy
direct path still reads its existing `VITE_ANTHROPIC_API_KEY` and remote MCP
configuration internally and uses `dangerouslyAllowBrowser`. That key is exposed
in the browser bundle; abstraction does not secure it. Bridge Claude login and
the Phase 2 broker/session authentication are unchanged.

## Turn ownership and cancellation

The Phase 3 owner supplies immutable `turnId`, `AbortSignal` and `current()`.
Provider chunks never choose or mutate that identity. The host adds the original
scope ID to events; adapters and frontend reject output from stale/cancelled
owners. Only one primary interaction is active, including its speech tail.

Cancellation quarantines output before requesting SDK abort and `Query.close()`.
Receipts distinguish not-started, termination-requested and
termination-unconfirmed; none claims remote execution or side effects were rolled
back. Direct streams receive the original signal and call stream abort. A result
that cannot terminate promptly remains quarantined. Terminal adapter cleanup
also rejects late chunks/permission callbacks. Transport timeout/disconnect uses
the existing turn cancellation path and clears pending camera/request state.
Bridge failures retain the Phase 3 `TurnCancelled('error')` promise behavior while
also delivering a normalized error event. Cancelled direct work returns reason
cancelled. The application adds no retries/replay of uncertain effectful requests;
the Agent SDK's internal policies remain provider-owned.

## Validation

`npm run test:providers` uses deterministic SDK/transport doubles, not paid calls.
It covers stream/reason/error/usage normalization, capabilities, image conversion,
session continuation, cancellation receipts/quarantine, private continuation
context, and the generic frontend seam. Existing `test:security` and
`test:lifecycle` remain required. Real service availability, configured-model
support and account authentication still require an authorized live smoke test.
