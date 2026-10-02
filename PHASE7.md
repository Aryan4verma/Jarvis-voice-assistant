# Phase 7 — cinematic startup and multi-provider AI

This milestone preserves the authenticated loopback bridge, immutable primary
turns, STOP/Escape cancellation, typed/voice brain, optional voice engines,
ECO rendering and latency diagnostics. No dependency or lockfile changes.

## Startup

Open the local page. INITIALISE and Space still work. Enable double-clap is the
first-time microphone/audio authorization fallback. A permission query never
prompts; an already granted microphone can arm automatically where the browser
allows audio analysis. Microphone permission does not override autoplay rules.
Suspended audio, denied permission and unsupported permission queries leave a
click fallback. No recording or acoustic history is saved.

`src/lib/clap.ts` detects two isolated, high-crest transients with rapid decay,
180–900 ms apart. Adaptive noise thresholds, a short onset window and cooldown
reject ordinary noise/sustained speech; this is a heuristic, not a guarantee
against every impact/noisy room. Its single 512-sample analyser uses the existing
shared microphone/context. Visible offline sampling is 10 ms; hidden/suspended
analysis backs off to 500 ms and performs no signal analysis. On detection,
manual initialization or unmount, timers/nodes stop before voice takes over.
The shared stream remains available; a second getUserMedia stream is not opened.

`Ignition.tsx` owns that listener. `startup.ts` owns global presentation metadata,
independent of AI turn IDs. App synchronously leaves offline and initializes
bridge, audio and optional speech concurrently. `Boot.tsx` has seven one-shot
line timers, a fade at 2.85 seconds and retirement at 3.2 seconds. Skip/Escape
can dismiss it. Chat/voice readiness never waits for that presentation clock.
There is no old 9.2-second blocking delay or ambient score.

Terminal lines use DOM/CSS and one SVG, without a new animation framework.
Bridge ONLINE means the authenticated connection is live. Cloud AI CONFIGURED
means key/model saved; READY follows an actual metadata test or successful
request. Claude LOGIN ON REQUEST does not claim a login was tested. Voice ARMED
does not claim successful recognition. Graphics/tools remain STANDBY during
the cinematic. Failures show UNAVAILABLE/DEGRADED instead of fabricated READY.
SceneHost stages the lazy heavy scene after presentation; its dark cover and
Phase 6 hidden warm frames/crossfade remain intact. ECO stays DPR 1, ~30 FPS
active, frozen when dormant/hidden. No heavy startup assets are added.

## AI Settings

Select OpenRouter, OpenAI, Google Gemini or Claude Agent. Selecting a card edits
a draft; Save AI Settings activates it. Test Connection also saves/activates the
draft explicitly. Switching cards clears temporary key input. Each API provider
keeps independent FAST/BALANCED/DEEP model mappings; blank FAST/DEEP uses BALANCED.
These modes select user mappings and bounded response budgets; they do not
invent unsupported reasoning controls or hardcode model generations.

Save/Replace/Delete Key operates on the selected provider only. Saved keys are
never revealed; password inputs clear on save. Windows CurrentUser DPAPI stores
`openrouter.dpapi`, `openai.dpapi` and `gemini.dpapi` in the existing private
`%LOCALAPPDATA%\JarvisAI\credentials` directory. Separate entropy purposes
prevent cross-slot decryption; original OpenRouter/voice purposes are preserved.
Plaintext travels only transiently over the authenticated same-origin broker
and backend pipes/headers. It is never saved in localStorage, config JSON, Git,
URLs or logs. No decrypted AI-key cache is added. DPAPI protects at rest for the
Windows user; it cannot isolate secrets from arbitrary software running as that
same user. Non-Windows storage fails closed; Claude Agent remains available.

Non-secret preferences live in `%LOCALAPPDATA%\JarvisAI\settings\ai.json`.
Its strict `profiles` field preserves other providers' mappings. Existing
OpenRouter preferences load without losing their selected model/key; saving
then writes the expanded format. Credential-looking native model IDs and
unexpected private preference fields are rejected.

Load model catalog makes an explicit backend metadata request. Native catalogs
are capped at 5,000 models/50 pages/15 seconds with a 30-minute RAM cache cleared
on key changes. OpenRouter uses its existing bounded public catalog/cache.
Test Connection checks key/model metadata without paid inference; OpenRouter
also explicitly verifies its public catalog. There is no provider polling or
background refresh. Generation never fetches a catalog. Manual model IDs remain
available; OpenRouter capabilities require Load catalog/Test Connection again
after bridge restart, except its documented Free Router contract.

OpenAI/Gemini model-list APIs do not return comprehensive modality/tool metadata.
Conservative documented general chat families get supported capabilities;
unknown IDs retain unknown vision/tool capabilities, so unverified activity is
blocked with an explanation. Specialized audio/image/research endpoints are
unsupported by these chat adapters. Current documented GPT-6 chat models are
recognized without making them defaults. o1-mini/preview remain
unknown; o3-mini vision is explicitly unsupported. Metadata tests cannot prove
all generation permissions; actual requests can still fail. Catalogs and manual
IDs avoid binding the product to one model or generation.

OpenRouter search, Free only, Vision and Tools filters show at most 50 matches,
with free models first. FREE requires known zero prompt/completion prices and
no other reported charge. Blank/boolean/unknown pricing does not become zero;
a `:free` name alone proves nothing. The explicit Free Router button selects
`openrouter/free`; free-pool availability varies. No paid model/provider fallback
or effectful request replay is added.

## Backend adapters and cancellation

`native-client.mjs` implements REST, bounded SSE/JSON, on-demand models and safe
errors. `native-chat.mjs` implements both wire formats behind existing JARVIS
contracts. OpenAI uses `/v1/responses`, streaming, `store:false`, typed images
and function calls. Gemini uses the official v1beta `streamGenerateContent`
endpoint, inline images and functionDeclarations. API keys stay in backend
headers; redirects are rejected. No SDK, daemon, worker or idle network loop is
introduced. Claude Agent SDK and OpenRouter adapters remain available.

Both reuse existing validated function-tools/permissions; native providers do
not inherit Claude's arbitrary external MCP servers. OpenAI encrypted reasoning
items and Gemini thought signatures are retained privately for tool continuation,
never exposed to the UI. Gemini charged thought tokens count in output usage.
Missing usage remains absent and monetary cost is not invented.

Each request has the same immutable application turn ID and AbortSignal. STOP,
Escape, barge-in, timeout, disconnect and settings changes use existing turn
cancellation. Fetch/stream/key reads abort; output/effects from uncancellable
work are quarantined. Abort does not prove remote computation/billing stopped,
and already executed external effects cannot be rolled back. Tools are bounded
to four rounds/eight calls per round; uncertain effects cannot be replayed with
a new call ID. Frames, text and continuation context are bounded and terminal
cleanup clears timers/sets/keys. Provider-specific wire types stay on Node.

Safe errors distinguish credentials, rate limits, missing models, network,
timeout and unsupported requests. Quota exhaustion and busy servers have
separate owned diagnostic codes/messages within the existing unavailable
category. Ambiguous provider rate/quota responses remain explicitly ambiguous;
raw provider/account/error messages never enter logs or frontend error bodies.
No request is automatically replayed and no provider is silently switched.

## Validation and limits

Final checks: `npx tsc -b --pretty false`, `npm run build`, `npm run lint`, Node
syntax checks, and all security/lifecycle/providers/OpenRouter/voice/phase7 suites.
All 123 tests pass: security 7, lifecycle 16, providers 19, OpenRouter/settings
33, voice/performance 14 and Phase 7 34. Syntax checks cover 45 JavaScript modules
and the DPAPI PowerShell script. The focused Phase 7 tests use mocked
SSE/HTTP/SDK/audio, never paid inference.
The authenticated real bridge/Vite integration also exercises native text,
tools, camera correlation, settings cancellation and independent encrypted keys.
Real Windows DPAPI round trips/cross-purpose failures are included.

Browser smoke uses an isolated temporary configuration/credential directory,
synthetic microphone/recognition/TTS and mocked AI. Chrome confirms dark offline
paint, one clap remaining offline, two claps starting the cinematic, immediate
clap retirement, one getUserMedia call, dark live transition, Space listening,
typed streaming/speech queue, provider switching, empty password fields after
save and metadata catalog/model selection. It does not validate physical clap
accuracy, actual speaker sound, driver-level flashing or numeric RAM/CPU/GPU
budgets. No successful paid-provider request or real key is used as evidence.
An isolated background launch was rejected by automatic approval review;
foreground test processes completed the smoke checks instead.

Build retains existing large optional chunk warnings; test loaders retain
Node's experimental-loader notice. Early missing-import/test-fixture assertions
and temporary smoke-fixture timing/syntax issues were corrected before final
validation. No unrelated future phase is implemented.

## File map

- Backend: `bridge/providers/native-client.mjs`, `native-chat.mjs`, `index.mjs`,
  `openrouter-client.mjs`; `bridge/server.mjs`, `ai-settings.mjs`,
  `settings-http.mjs`, `secrets.mjs`; `scripts/dpapi.ps1`.
- Startup/render staging: `src/lib/clap.ts`, `startup.ts`, `capabilities.ts`,
  `src/ui/Ignition.tsx`, `Boot.tsx`, `src/App.tsx`, `src/scene/SceneHost.tsx`,
  `Scene.tsx`, `src/index.css`.
- Settings/filter: `src/lib/settings.ts`, `modelFilter.ts`, `src/ui/AISettings.tsx`.
- Tests: `tests/phase7.test.mjs`, `frontend-loader.mjs`, `sdk-loader.mjs`,
  `openrouter.test.mjs`, `openrouter-integration.test.mjs`, `settings.test.mjs`;
  `package.json` adds `test:phase7` only.
- Guides/examples: `README.md`, `.env.example`, `OPENROUTER_SETTINGS.md`, this file.

Official contracts checked: [OpenAI streaming Responses](https://developers.openai.com/api/docs/guides/streaming-responses),
[OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling),
[OpenAI model list](https://developers.openai.com/api/reference/resources/models/methods/list),
[OpenAI model capabilities](https://developers.openai.com/api/docs/models),
[Gemini generate/stream API](https://ai.google.dev/api/generate-content),
[Gemini models API](https://ai.google.dev/api/models),
[OpenRouter Free Router](https://openrouter.ai/docs/guides/routing/routers/free-router).
