# JARVIS — holographic personal assistant

An independent personal assistant customized by Aryan Verma from
[Aditya Dewaskar's JARVIS](https://github.com/adewaskar/jarvis). It combines typed
and voice chat, a cyan holographic interface and cloud inference through an
authenticated local Node bridge. It is a modified derivative, not a new project
built entirely from scratch. [Attribution](ATTRIBUTION.md) · [MIT license](LICENSE).

## Main features

- Typed chat with Enter/Send, streaming replies and STOP/Escape cancellation.
- Voice commands with browser recognition, system speech and sentence streaming;
  Space is push-to-talk. Optional ElevenLabs STT/TTS and Picovoice Porcupine wake
  detection use Voice Settings. “Hey Jarvis” uses browser recognition by default;
  optional Porcupine detects its built-in “Jarvis” keyword.
- Backend OpenRouter, OpenAI Responses API and Google Gemini adapters, plus the
  existing Claude Agent SDK mode. Selected-model capabilities gate vision/tools.
- Separate Windows-protected provider keys and FAST/BALANCED/DEEP model mappings.
  Catalogs load on request; manual IDs remain available. OpenRouter has Free,
  Vision and Tools filters and explicit `openrouter/free` selection.
- Two-clap ignition, click/Space fallbacks and a concurrent ~3.2-second terminal
  boot. Browser permission/autoplay rules apply. Sounds are synthesized; no music
  recordings ship in the current tree.
- Lazy 3D startup and ECO defaults: DPR 1, ~30 FPS while active, settled standby
  and hidden-tab rendering suspension. Camera/gestures are opt-in.
- Existing display/UI/camera tools, authenticated media/file serving and
  event-based latency diagnostics. External/browser tool availability differs
  between providers; see the table below.

## Hardware target and requirements

Development targets a Windows 64-bit laptop with an Intel i3-class CPU, 8 GB RAM
and integrated graphics. These are optimization targets, not measured minimum
requirements or a promise of a particular RAM/FPS budget. Cloud inference avoids
local LLM loading; optional neural TTS/hand tracking/wake features still cost
resources and can remain disabled.

Use Node.js **`^20.19.0 || >=22.12.0`**, npm, and a normal Chrome/Edge window.
Microphone and camera need browser permission; typed chat remains available if
voice fails. Choose an API-provider account/key or your independently configured
Claude Agent authentication. Optional integrations need their own setup and terms.

## Install and run

From the folder containing `package.json` (currently `jarvis`):

```powershell
npm ci
npm start
```

Open the local URL printed by the launcher (normally `http://localhost:5173`).
Click **INITIALISE** or press **Space**. For double-clap ignition, use **Enable
double-clap** once to authorize the shared microphone/audio; already granted
permission may allow later starts to arm automatically. Clap detection runs only
while offline and retires immediately at startup. Permission does not override
browser autoplay restrictions.

For separate terminals, use `npm run bridge` and `npm run dev`. `npm run setup`
is an advisory preflight, not a credential/permissions test. MediaPipe runtime
assets and legal notices are prepared for normal Vite workflows. `npm run preview`
serves the built frontend through the local broker; run the bridge separately.
An unrelated static host cannot replace that broker. Ctrl-C stops the launcher
and its direct children; optional MCP descendant cleanup is not fully redesigned.

## Provider setup

Open **AI Settings**, select a provider and save/replace its key through the
password field. The stored key is never revealed. Pick FAST/BALANCED/DEEP models,
then **Save AI Settings** to activate them. **Test Connection** activates the
draft and checks key/model metadata without paid inference. Provider switching
preserves other providers' keys and mappings and cancels any active interaction.

Catalogs are explicit, bounded requests with a small RAM cache. Unknown model
capabilities stay unknown; specialized endpoints may be unsupported. OpenRouter
needs Load catalog/Test Connection again after a bridge restart for verified
vision/tools, except its documented Free Router contract. Free status requires
known zero pricing; models are never silently switched to paid alternatives.
There is no automatic provider fallback or polling. Account charges, quotas and
model access remain controlled by each provider.

Claude Agent preserves the existing SDK and its own CLI authentication. Install
and authenticate Claude Code through [Anthropic's official instructions](https://code.claude.com/docs/en/overview)
if using that mode. JARVIS does not collect Claude account passwords/OAuth tokens.
Usage eligibility/billing and redistribution follow [Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance),
not this repository's MIT license. No subscription or unlimited-use guarantee is made.

[Multi-provider details](PHASE7.md) · [AI contracts](AI_PROVIDERS.md) ·
[OpenRouter settings](OPENROUTER_SETTINGS.md).

## Tools and Windows browser status

| Mode / component | What the current code supplies | Limits |
| --- | --- | --- |
| OpenRouter / OpenAI / Gemini | Validated JARVIS display, interface and supported camera function handlers | Requires verified model tool/vision capabilities; no arbitrary MCP, filesystem, phone, email or browser-control functions supplied. |
| Claude Agent | Existing agent runtime plus configured MCP servers from the user's `.claude.json`, and local display/UI/vision/browser servers | Availability depends on installed tools, credentials and SDK permission behavior. These external integrations were not live-verified in this polishing pass. |
| Custom Chrome transport (`bridge/chrome.mjs`) | Discovery/connect code for `/tmp/claude-mcp-browser-bridge-<user>/<pid>.sock` | Unix socket/native-host assumption remains. Native Windows Chrome/Edge control is **incomplete and unverified**; there is no Windows named-pipe implementation here. |
| External browser MCP | User-configured servers can be passed to Claude Agent | The current Claude persona directs browsing through the custom Chrome tools and discourages Playwright/Puppeteer. Configuring a server alone is not proof that Windows browser actions work. |
| HTTP page/media reader | Guarded backend URL/file retrieval and sanitized display | Fetching public content is not native browser control or authenticated browser-session access. |

`npm run bridge:writes` broadens existing effectful-tool permissions; it does
not implement missing integrations. The permission callback is not a complete
sandbox: SDK auto-approved actions can bypass it. Review `decideTool` and your
MCP configuration before enabling writes. No new browser transport is implemented.

## Voice and controls

| Control | Behavior |
| --- | --- |
| “Hey Jarvis” / configured wake engine | Start command listening after initialization |
| Space | Initialize or enter push-to-talk listening |
| Enter / Send | Submit typed chat |
| STOP / Escape / barge-in | Cancel the owned interaction and speech; Escape also dismisses the boot |
| V | Cycle system voices |
| D | Latest-interaction latency diagnostics |
| T | Audio self-test |
| G | Optional hand interaction |

Voice Replies defaults to Always; Voice requests only and Off are available.
Voice Settings stores optional voice credentials under Windows protection.
Browser recognition may send audio to the browser vendor. ElevenLabs audio goes
to ElevenLabs when used; command STT does not continuously upload standby room
audio. Picovoice's Web SDK must receive its AccessKey transiently in its worker
and can perform vendor license checks. Optional Kokoro is explicitly selected
and has separate resource/distribution limits. [Voice/performance details](VOICE_PERFORMANCE.md).

## Security and privacy

AI/ElevenLabs keys remain backend-only and are stored outside Git/config JSON
using **Windows CurrentUser DPAPI**, under `%LOCALAPPDATA%\JarvisAI\credentials`.
Non-secret preferences live in `%LOCALAPPDATA%\JarvisAI\settings`. No permanent
AI key belongs in a `VITE_*` variable, localStorage, a URL or committed file.
DPAPI protects at rest for that Windows user; it does not protect against malware
running as that same user or an administrator. Secret storage fails closed on
unsupported platforms; Claude Agent remains an option.

The bridge binds to `127.0.0.1`; authenticated HTTP/WebSocket requests use a Node
broker and an origin-bound HttpOnly/SameSite browser session. Bridge bearer
credentials stay on Node. `/health` only reports `{"ok":true}`. SSRF, size,
path/realpath and markup guards remain. File access is limited to private runtime
artifacts or narrow configured `JARVIS_FILE_ROOTS`; drive/home/temp roots are not
approved. This application is local software, not a LAN/cloud hosting service.

Private runtime records use `%LOCALAPPDATA%\JarvisAI\bridge\<checkout-id>`.
AI messages and optional camera images go to the selected provider; provider
retention/terms apply. Google Fonts requests expose normal request metadata.
Logs omit raw credentials, transcripts and provider error bodies. There is no
SQLite/persistent personal memory implementation. Conversation text in the UI
is temporary; an agent may manage its own session data outside this repository.

Ignore rules cover environment secrets, DPAPI blobs, databases, settings,
transcripts, captures, recordings, logs, dependencies and generated outputs.
Ignore rules do not sanitize already tracked history or files copied into a
build. Never commit private MCP configuration or public-directory overrides.

## Known limitations

- Native Windows browser automation remains incomplete, as described above.
- No real paid-provider generation, physical clap accuracy, actual speaker output
  or numerical low-end hardware budget was verified by the automated suites.
- Permission/autoplay restrictions and browser speech availability vary; use
  INITIALISE, Space or typed chat when optional features fail.
- STOP aborts supported requests and quarantines stale output. It cannot undo
  completed external actions or prove remote computation/billing stopped.
- Model-list metadata is incomplete. Metadata tests do not prove every inference
  permission; quota/network/busy/model failures can still occur.
- Existing optional chunks are large. Neural TTS and gestures are optional;
  default cloud AI does not load a local LLM.
- **Compiled-release licensing is not fully cleared.** Claude/Picovoice terms,
  embedded eSpeak NG in the optional Kokoro path, native transitive libraries and
  separately downloaded models need distribution review. See the notices below.
  Do not advertise an installer/bundle as entirely MIT-licensed.

## Validation

```powershell
npx tsc -b --pretty false
npm run build
npm run lint
npm run test:security
npm run test:lifecycle
npm run test:providers
npm run test:openrouter
npm run test:voice
npm run test:phase7
git diff --check
```

Tests use deterministic doubles rather than paid model requests, including real
Windows DPAPI and authenticated local bridge tests. They do not constitute a full
live-service/hardware end-to-end certification. Keep secret scanning and staged
file review in the publishing workflow.

## License, attribution and disclaimer

[LICENSE](LICENSE) preserves **Copyright (c) 2026 Aditya Dewaskar** unchanged.
[ATTRIBUTION.md](ATTRIBUTION.md) identifies the modified derivative and Aryan
Verma's extensions. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) records direct
dependency licenses and unresolved distribution terms; [ASSET_AUDIT.md](ASSET_AUDIT.md)
records retained, generated and removed assets. Dependencies retain their own
licenses. Build/preview legal documents are served under `/legal/`.

This independent open-source personal project is not affiliated with or endorsed
by Marvel, Disney, OpenAI, Google, Anthropic or other providers. Product/provider
names belong to their respective owners. The JARVIS name is retained; a disclaimer
does not guarantee trademark clearance or permission to republish external media.
