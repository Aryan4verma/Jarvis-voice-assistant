# Interaction ownership and cancellation

`src/lib/turn.ts` owns one primary interaction, including its speech tail.
`App.tsx` allocates a frozen turn with a random `turnId` when accepting a user
request. Starting another turn cancels the previous owner. A completed or
cancelled owner cannot clear a newer owner. No completed-turn history is retained
by the lifecycle manager; the existing UI transcript is separate.

`brain.ts` passes the same turn to either existing backend. The bridge protocol
uses `{type: 'ask', turnId, text}` and `{type: 'cancel', turnId}`. All interaction
frames carry `scope: 'turn'` and that original ID: text, tool status, panels,
blades, UI commands, camera requests/replies, errors, completion, and cancellation.
Only readiness/server availability uses `scope: 'connection'`. The client checks
both the originating socket and the active turn before applying a frame.

`bridge/turn.mjs` closes over an immutable ID. Each Agent SDK query receives its
own callbacks, abort controller, and scoped tool handlers. The connection retains
the last successful SDK session ID and uses `options.resume` for subsequent
queries. It does not reuse an agent stream whose late messages could be assigned
to another turn. SDK conversation files remain SDK-managed; this introduces no
new memory database. Cancelling a turn does not erase existing SDK transcripts.

## Cancellation

Escape, spoken STOP/cancel, barge-in, replacement, the bridge client's 120-second
inactivity timeout, disconnect, and shutdown all cancel the turn owner. Output is
quarantined before backend cancellation hooks run. Owned speech, capture waits,
timers, and input assembled for the old interaction are cleared. Barge-in keeps
the new input being spoken. Browser recognition callbacks retain their recognizer
identity; cloud STT uses input generations until a transcript becomes a turn.

The bridge calls both the supported SDK `AbortController.abort()` and
`Query.close()` (which terminates the SDK CLI and releases its query resources).
Its receipt says `termination-requested`, or `termination-unconfirmed` if close
throws; it does not claim that remote effects have been undone. A UI timeout is
an abandoned turn plus a cancellation request, not proof of backend termination.
HTTP speech requests abort their upstream fetch on disconnect/shutdown. The
direct Anthropic path passes a signal and calls its own stream's `abort()`.

Speech retains sentence streaming and one-sentence prefetch. Each speaker has
its own controller and playback identity, so old cleanup cannot stop the next
speaker. Native/audio playback ends locally on cancellation, queued speech is
discarded, generated URLs are released, and late synthesis results cannot play.

## Bounds and retry policy

Camera correlation maps hold at most two requests per turn, with a 20-second
deadline and explicit capture cancellation. Camera acquisition waiters are
removable and capped at 16. Tool bookkeeping is capped at 256 entries, native
browser calls at 16 queued operations, speech at 128 queued sentences, and STT
at six queued clips / 8 MiB. Optional Kokoro generations are serialized and
capped at four pending jobs. Terminal paths clear owned maps and speech/STT
queues immediately; cancelled ONNX jobs leave their bounded generation queue
when the executing kernel settles. Camera permission has one shared OS request
with removable waiters rather than retaining an abandoned waiter per turn;
reconnect keeps the existing six-attempt backoff and never replays a user request.
These changes add no permanent worker, periodic poll, or dependency.

Native browser retries are restricted to explicit reads/screenshots. Navigation,
clicks, typing, form changes, tab creation/closing, and other effects are not
blindly repeated after transport failure. Their uncertain outcome is surfaced.
An ambiguous cancelled/timed-out socket is discarded before another request.
Direct Anthropic automatic HTTP retries are disabled. The existing authenticated
HTTP 401 refresh retry remains because the bridge rejects unauthorized requests
before running their effects. SDK-internal model retry behavior is SDK-managed;
JARVIS does not replay an entire agent turn automatically.

## Limits and validation

An external action already dispatched cannot be rolled back. Closing the SDK's
query is supported; guaranteeing termination of every optional MCP descendant
remains a separate process-supervision phase. OS camera/microphone permission
prompts and an executing optional ONNX generation cannot be forcibly cancelled
by these browser APIs. Local camera waits are rejected and late camera tracks/results
are stopped/discarded. A late voice initializer is stopped without updating the
unmounted UI; the existing shared microphone lifetime is unchanged. One query per
turn adds CLI/MCP startup work, while
removing the persistent idle query; measure this tradeoff with real credentials.
The existing Unix-native browser transport is unchanged.

`npm run test:lifecycle` exercises production lifecycle code and an authenticated
bridge with deterministic SDK/browser/speech doubles, including a backend that
deliberately ignores abort/close. `npm run test:security` retains the Phase 2
security suite with the new turn protocol. Tests require no AI credentials and
do not validate live model latency, Windows native speech, or physical devices.
