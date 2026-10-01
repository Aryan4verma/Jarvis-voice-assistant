# Phase 6: voice responsiveness and ECO graphics

## Causes confirmed in code

- Space called the wake greeting rather than entering a command directly.
- `ignite()` awaited a deliberate 9200 ms delay and bridge readiness.
- `respond()` created speakers only for voice requests, making typed replies silent.
- Scribe/VAD transcribed standby noise to search for the name; Porcupine dependencies were unused.
- Short one/two-word commands incurred a 1600 ms assembly delay, on top of capture silence and network latency.
- `getMic()` cached only resolved streams, allowing concurrent permission calls to open multiple streams.
- The scene mounted before initialization, used transparent WebGL/DPR up to 2, and continuously ran the full post-processing chain. HTML had no critical dark style before CSS arrived.

These explain application-controlled startup/latency problems. The changes do
not establish that every driver/compositor flash reported on the physical laptop
has been eliminated; physical Chrome/Edge testing remains necessary.

## Voice ownership and configuration

Typed and spoken requests still enter `App.respond` and the existing immutable
turn/AI bridge contracts. Space and wake share synchronous command entry without
a greeting. Speech queues, transcription generations, PCM wake epochs and late
callbacks are quarantined on reset/cancellation. Turn A cannot stop B's speech.

`audio.ts` shares one permission promise/stream/context; its input requests echo
cancellation, noise suppression and gain control. Modern browser recognition
receives the shared track where supported. The legacy browser API may use its own
internal microphone capture if it does not support `start(audioTrack)`.

Scribe runs only for commands/barge-in, with single-flight transcription, bounded
queued bytes/counts, request cancellation and actionable service errors. VAD uses
25 ms sampling, a 400 ms quiet endpoint, early onset recording and per-recorder
buffers; completed text waits only 80 ms (or zero for explicit punctuation).
Clearly unfinished text may wait 1600 ms, bounded to 6 seconds. Browser interim
results remain visible and browser finals avoid the old extra 900 ms delay.

Voice Settings saves optional ElevenLabs/Picovoice keys under
`%LOCALAPPDATA%/JarvisAI/credentials/*.dpapi`, encrypted by Windows CurrentUser
DPAPI with separate purposes. ElevenLabs decrypted bytes have a small Node-only
request-time cache (five-minute reuse window, no timer; replacement/deletion/
shutdown or the next expired read wipes it)
to avoid launching PowerShell for every speech segment. It is never returned to
the frontend or written unencrypted. Existing OpenRouter ciphertext remains compatible.
ElevenLabs environment/MCP configuration remains a backend-only compatibility
path; use protected settings for new keys. Deleting a stored ElevenLabs key does
not delete a separately configured environment/MCP key.

Porcupine is optional, CPU-only, one thread, one inference worker, one bounded
in-flight PCM frame. It reuses the microphone through a small AudioWorklet instead
of WebVoiceProcessor's second stream/resampler worker. Initialization timeout,
missing key, unsupported audio/IndexedDB, download/license failure or runtime
failure falls back to browser wake recognition. It recognizes the built-in
“Jarvis” portion of “Hey Jarvis”, then arms command recognition. Space does not
wait for it. Parameter-model v4 (~985 KB) downloads from Picovoice's official
repository only on optional setup and the SDK caches the model in IndexedDB.
The generated inference worker (~3.35 MB) is a lazy asset.

**Important runtime distinction:** Porcupine Web requires the AccessKey inside
its browser worker and may contact Picovoice for license validation. The key is
never placed in source, localStorage, ordinary settings, logs or Git. Permanent
storage is DPAPI; OpenRouter and ElevenLabs credentials are never returned to the
frontend. This protects at rest, not against malware/debugging by the same
Windows user or compromised running page. No live key was used during testing.

Voice Replies is a non-secret local preference (Always by default, Voice requests
only, Off). System TTS is default regardless of Scribe configuration. Existing
sentence streaming, one-sentence prefetch, STOP/Escape and cloud/Kokoro opt-in
remain. Native failure does not permanently disable system speech when there is
no cloud rescue; the UI reports audio failure and preserves the text reply.

## Startup and graphics

HTML supplies the dark first paint independently of React/CSS. The Three.js scene
loads after initialization, behind a matching dark placeholder until initial
frames settle. Renderer alpha is off with a fixed dark clear/background, DPR 1,
low-power preference and no hardware antialiasing on already-soft shader shapes.
Only bloom remains, at half resolution. Geometry/particle counts are preserved.
Graphics initialization/context-loss failures leave a static holographic fallback
and retain chat/voice.

Demand rendering runs at approximately 30 FPS while active. UI/phase changes get
a bounded settling burst (~0.5 s), then standby has no scheduled animation;
visibility changes stop frames while hidden. The audio-level pump also stops in
standby/hidden tabs. Camera/gesture tracking stays explicit. Automatic clap
capture and cinematic score/ambient startup are disabled in ECO (modules/assets
retained). The legacy Boot component remains visual-only, with no functional
startup wait. Optional bridge/wake setup does not block typed interaction.

Initial production application chunk is approximately 608 KB (previously 1.57
MB); Scene is a separate ~968 KB lazy chunk. Existing optional Kokoro/ONNX assets
still generate large-chunk warnings but are not default startup downloads.
No dependencies, AI daemons, memory databases or polling provider workers added.

## Errors and timings

OpenRouter errors distinguish key permissions, platform HTTP 429 quotas,
upstream/free-provider capacity, missing models, network failure, timeout, account
credits, key spending caps and temporary in-flight budgets. Bounded error parsing
uses metadata/status/Retry-After, never raw provider messages. Numeric or HTTP-date
Retry-After becomes a bounded human wait hint and typed diagnostics field. There
is no request retry, tool replay or automatic paid fallback.

D shows one latest interaction's event timestamps/durations: wake/listening,
speech endpoint/STT, AI request/first token, first real audio and completion.
Missing events display a dash, never fabricated zero audio latency. Cancelled
turns cannot update newer measurements. Only the existing open diagnostics panel
refreshes; timings themselves have no sampling timer/history/logged transcript.

## Verification

`npm run test:voice` adds deterministic voice, endpointing, microphone sharing,
wake fallback, speech ownership, render policy/first paint, error and latency
tests plus real Windows DPAPI purpose-isolation tests. Existing security tests
include the new voice settings/session endpoints. Run all earlier suites too:

```
npx tsc -b
npm run build
npm run lint
npm run test:security
npm run test:lifecycle
npm run test:providers
npm run test:openrouter
npm run test:voice
```

Validation passed: TypeScript, production build, lint, JavaScript syntax checks
and 88 tests across the five security/lifecycle/provider/OpenRouter/voice suites.
The build retains warnings about large optional chunks, and Node reports its
existing experimental test-loader warning. No final validation command failed.

Browser smoke uses an isolated test-only bridge SDK and synthetic microphone,
without personal audio, keys, MCP effects or paid inference. It verifies the dark
initial/live view, initialization, Space listening and typed text response.
The in-app browser exposed installed Windows voices but did not signal actual
native audio start; the new failure warning handles this honestly. Deterministic
TTS tests confirm queue cancellation/ownership; physical Chrome/Edge audio,
Porcupine accuracy with a real key, driver-level flashing and numeric CPU/GPU/RAM
budgets are not claimed as measured here.

Sources used to verify integration contracts:
[Porcupine Web documentation](https://picovoice.ai/docs/quick-start/porcupine-web/)
and [OpenRouter limits/errors](https://openrouter.ai/docs/api/reference/limits).

## Changed files

All 41 files belong to this phase; no dependency or lockfile changes.

**Documentation/configuration**

- `.env.example`
- `OPENROUTER_SETTINGS.md`
- `README.md`
- `index.html`
- `package.json`
- `src/config.ts`
- `VOICE_PERFORMANCE.md`

**Backend/security/provider errors**

- `bridge/providers/openrouter-client.mjs`
- `bridge/providers/openrouter.mjs`
- `bridge/secrets.mjs`
- `bridge/server.mjs`
- `scripts/dpapi.ps1`
- `shared/ai.d.mts`
- `shared/ai.mjs`
- `bridge/voice-settings.mjs`

**Voice/interaction/timing**

- `src/lib/audio.ts`
- `src/lib/capabilities.ts`
- `src/lib/tts.ts`
- `src/lib/vad.ts`
- `src/lib/voice.ts`
- `src/lib/graphics.ts`
- `src/lib/interaction.ts`
- `src/lib/latency.ts`
- `src/lib/voiceSettings.ts`
- `src/lib/wake-worker.ts`
- `src/lib/wake.ts`

**Interface/graphics**

- `src/App.tsx`
- `src/index.css`
- `src/scene/Scene.tsx`
- `src/ui/ChatInput.tsx`
- `src/ui/Diagnostics.tsx`
- `src/ui/Ignition.tsx`
- `public/wake-audio.js`
- `src/scene/SceneHost.tsx`
- `src/ui/VoiceSettings.tsx`

**Tests**

- `tests/bridge-security.test.mjs`
- `tests/frontend-loader.mjs`
- `tests/lifecycle.test.mjs`
- `tests/microphone.test.mjs`
- `tests/voice-performance.test.mjs`
- `tests/voice-settings.test.mjs`
