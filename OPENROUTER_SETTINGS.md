# OpenRouter and typed chat

Run `npm start`, then open the local JARVIS page. Typed chat works immediately,
without microphone permission or the voice boot sequence. Enter sends; STOP or
Escape cancels generation. Voice uses the same brain and turn owner. Typed
responses use sentence-streamed system speech by default, as do voice responses.
Voice Settings → Voice Replies selects Always (default), Voice requests only, or Off.

Open **AI Settings**:

1. Choose OpenRouter and paste your key into the password field. Save Key (or
   Replace Key) clears the field; the saved key is never fetched back to the UI.
2. Load the model catalog, search by name/ID, and choose model mappings. Set a
   BALANCED model; blank FAST/DEEP mappings use BALANCED. You can enter a model ID
   directly. No three particular models are required.
3. Save AI Settings or use Test Connection. The test saves the selections, checks
   the key and model, and makes no paid chat-completion request.

FAST uses a smaller output budget and low reasoning effort, BALANCED medium,
DEEP a larger budget and high effort. Reasoning controls are sent only when
advertised by the model. Model costs and latency still depend on the chosen
model. Vision and function support are shown as yes/no/unknown. Unknown vision
is rejected; unknown tool/reasoning support is not assumed. Unsupported tools
are omitted, with their capabilities visible in settings. Metadata comes from
the [OpenRouter model catalog](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties).

The catalog loads only on demand and is cached in backend RAM for 30 minutes.
An explicit catalog refresh bypasses the cache. There are no provider polling loops, model daemons, permanent workers, or new
dependencies. Readiness updates on explicit testing or actual requests.

## Storage and authentication

Windows stores the encrypted key at
`%LOCALAPPDATA%\JarvisAI\credentials\openrouter.dpapi`. Non-secret preferences
are at `%LOCALAPPDATA%\JarvisAI\settings\ai.json`. Both are outside the repository;
storage paths inside the repository, UNC paths and direct symbolic links are
refused. Do not copy these files into Git or artifact directories.

A short-lived, hidden Windows PowerShell helper calls the built-in .NET DPAPI
Protect/Unprotect API with **CurrentUser** scope. The key travels over stdin,
never command arguments, environment variables, temporary plaintext files or
logs. It is decrypted per request/test, with no permanent plaintext cache.
The key necessarily exists briefly in Node memory and in the settings password
field while being entered. JavaScript strings cannot guarantee memory erasure.

DPAPI protects data for the Windows user; another program running as the same
user can also decrypt it. It is not protection against a compromised user session.
Moving the encrypted file to a different Windows account will not unlock it;
replace the key in settings. See [Microsoft's DPAPI documentation](https://learn.microsoft.com/en-us/dotnet/api/system.security.cryptography.protecteddata?view=windowsdesktop-9.0).

Settings endpoints use the existing loopback Host/Origin/bearer checks and the
Vite HttpOnly session broker. Mutations additionally require an allowed Origin
and `x-jarvis-settings: 1`. Responses contain configured state, model metadata and
safe readiness/errors, never the key or OpenRouter account/key-label payload.
Delete Key removes the encrypted file. Saving configuration or replacing/deleting
a key cancels active generation and replaces its adapter without re-labeling work.

## Provider scope and cancellation

OpenRouter uses backend streaming chat completions. Its functions reuse existing
validated JARVIS display, blade, interface and supported camera handlers. These
events keep the original turn ID. Camera images enter only the private provider
continuation context; they are not added to transcript history.

Claude Agent remains available with its existing login, SDK session, permission
gate, browser and MCP integrations. Its model/effort still use `JARVIS_MODEL` and
`JARVIS_EFFORT`. OpenRouter does not claim access to Claude's external agent/MCP
tools. Browser-direct Anthropic is retired: `VITE_BACKEND=direct` and
`VITE_ANTHROPIC_API_KEY` no longer enable a browser provider or get read by the app.
Remove old AI keys from `.env.local` and rotate previously exposed keys.

STOP, Escape, replacement, timeout and disconnect quarantine the turn first and
abort OpenRouter's fetch/body stream. A total backend request deadline is 90
seconds. Connection abort does not guarantee every upstream provider stops billing
or processing; [OpenRouter documents that limitation](https://openrouter.ai/docs/api/reference/streaming).
Already dispatched effects cannot be undone. Late uncancellable results cannot
affect another turn. Uncertain requests are never automatically replayed, and an
uncertain tool dispatch cannot be retried with the same arguments in that turn.
Continuations, context, frames, tool calls and encoded images are bounded.

Optional non-secret initial model mappings: `JARVIS_OPENROUTER_FAST_MODEL`,
`JARVIS_OPENROUTER_BALANCED_MODEL`, `JARVIS_OPENROUTER_DEEP_MODEL`. Saved settings
take precedence. `JARVIS_AI_PROVIDER` accepts `claude-agent` or `openrouter` as
the initial default; a key always comes from protected settings storage.

## Verification

`npm run test:openrouter` covers mocked streaming, HTTP/midstream failures,
capabilities, function/vision continuations, cancellation, encrypted settings,
safe DTOs, CSRF checks, real Windows DPAPI, and real bridge/broker integration
with a mocked provider. `npm run test:providers` additionally tests typed-chat
delegation and retains Claude SDK coverage. No real API key or paid credits are
needed. Security/lifecycle suites, typecheck, build and lint remain required.
Real account credentials and the selected upstream model still need the user's
Test Connection and first actual request.
