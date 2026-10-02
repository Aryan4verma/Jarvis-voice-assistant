# J.A.R.V.I.S.

A browser voice assistant with an Iron Man holographic interface. Windows AI
Settings supports OpenRouter, OpenAI, Google Gemini and the existing Claude Agent
login. See [Phase 7 setup, startup and validation](PHASE7.md). Say
**"Hey Jarvis"**, he wakes, listens, and does real things through your tools —
searches the web, generates images, drives your phone, reads your mail. The face
is a web page (React + Vite + Three.js + custom GLSL). The original agent brain is Claude Code,
run headless as a library.

**Claude Agent mode reuses your Claude Code subscription.** Alternatively,
configure a cloud provider key in AI Settings. Provider charges depend on your
chosen account/model; there is no automatic paid fallback. In Claude mode the
brain runs on your existing Claude Code login, and
the heavy work (the model itself) runs on Anthropic's servers, so even a low-end
laptop only has to draw the interface. **ElevenLabs is an optional add-on** that
gives JARVIS a much better voice and sharper hearing; without it he speaks and
listens through the browser's own speech, and everything still works.

---

## Requirements

**In one line:** Node.js and Chrome/Edge, plus either a configured cloud-provider
key or the existing Claude Code login.

- **Claude Agent mode: Claude Code, installed and logged in** — native API modes
  use their provider key instead.
  Install it with the official method — `npm install -g @anthropic-ai/claude-code`,
  or the platform installer at <https://docs.claude.com/en/docs/claude-code> —
  then run `claude` once and complete login. The bridge reuses that login. **No
  API key**, and usage is billed to your existing Claude account.
- **Node.js `^20.19.0 || >=22.12.0`** — Node 20 requires 20.19 or newer;
  otherwise use 22.12 or newer. **Node 24 LTS is recommended.** This matches
  the locked Vite, React plugin, and lint tooling. A supported installed version
  does not need to be changed. Installers are at <https://nodejs.org>.
- **Google Chrome or Microsoft Edge**, in a **real browser window** — not an
  embedded preview pane. Preview panes (including the one inside editors and
  Claude Code) block microphone access, so the page loads and looks right but
  never hears you. JARVIS also needs WebGL, which these browsers provide.
- **Optional: an ElevenLabs API key** — a good add-on, not a requirement. It
  gives a better voice and sharper transcription; the free tier is plenty for a
  demo. Without it, everything runs on the browser's own speech.

Run `npm run setup` after cloning and it checks all of this for you, in plain
language.

---

## Quick start

First, install, then start it:

```bash
npm ci             # reproducible installation from package-lock.json
npm start          # runs the brain and the face together
```

Then open the URL it prints (http://localhost:5173) in **Chrome**. Click **INITIALISE** or press Space. For double-clap activation, click **Enable double-clap** once to authorize the shared microphone; future starts arm automatically when browser permissions allow it. Say **“Hey Jarvis”** after startup.

Prefer two terminals? Run them separately instead:

```bash
npm ci
```

Terminal 1 — the brain:

```bash
npm run bridge
```

Terminal 2 — the face:

```bash
npm run dev
```

Then open the app in a **real Chrome or Edge window**. On Windows PowerShell:

```powershell
Start-Process http://localhost:5173
```

Click **INITIALISE**, allow the microphone when asked, and say **"Hey Jarvis"**.

> It has to be a real browser window. Embedded preview panes block the
> microphone, so JARVIS will look perfectly alive and simply never respond.

### Windows development/build baseline

Run these commands from the repository directory:

```bash
npm ci
npm run setup
npm run build      # TypeScript project checks, then the production bundle
npm run lint
npm start
```

`npm start`, `npm run bridge`, and `npm run bridge:writes` use Node directly;
the write-mode command does not require Unix environment-variable syntax.
Ctrl-C stops the launcher and its two direct children. Full cleanup of optional
agent/MCP descendant processes is a separate lifecycle concern.

MediaPipe's pinned JavaScript/WASM runtime is prepared automatically for
`start`, `dev`, `build`, and `preview`. The generated `public/mediapipe` directory
is ignored by Git and copied into production output. Unchanged assets are reused;
missing or incomplete assets are repaired. Optional hand-model weights still
need network access when not already cached.

`npm run preview` serves the production frontend; start `npm run bridge` in a
second terminal for AI requests. Run `npm run test:security` for the focused
bridge security suite; there is no full application end-to-end suite.
Run `npm run test:lifecycle` for deterministic turn, cancellation, speech,
camera, retry, and disconnect tests without AI credentials. See
[TURN_LIFECYCLE.md](TURN_LIFECYCLE.md) for ownership and cancellation guarantees.
Setup is advisory and does not establish Claude login or microphone/camera
permissions. The existing Chrome native-host transport still assumes Unix
sockets; Windows browser automation remains a later compatibility task.

---

## How it works

JARVIS is two processes. The browser is the face and the voice; the bridge is
the brain and the hands.

```
  ┌─ browser (the face) ───────────────┐        ┌─ bridge (the brain) ─────────────┐
  │  "Hey Jarvis" wake word            │        │  Node · bridge/server.mjs        │
  │  local VAD  →  speech to text      │   ws   │  Claude Agent SDK                │
  │  reactor UI (Three.js + GLSL)      │◄─────► │   = Claude Code, headless        │
  │  text to speech                    │  8787  │  spawns your MCP servers         │
  │  heads-up display                  │        │  permission gate (decideTool)    │
  └────────────────────────────────────┘        └──────────────────────────────────┘
```

Everything you see and hear happens in the browser. The bridge is a single Node
process (`bridge/server.mjs`) that runs the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`) — this spawns the real `claude` CLI as a child
process, so **the brain literally is Claude Code, headless.** They talk over a
WebSocket (plus a few HTTP endpoints) on `127.0.0.1:8787`, reached through
Vite's authenticated same-origin broker.

**Why a bridge at all?** A browser tab cannot spawn the local stdio MCP servers —
`higgsfield`, `elevenlabs`, `android`, `playwright`, `exa`, `serper`, and the
rest. The bridge can. And because it is the Agent SDK, it authenticates off your
existing Claude Code login: no API key, billed to that same Claude account.

**The model.** `claude-opus-5` at effort `medium` by default. Override with the
`JARVIS_MODEL` and `JARVIS_EFFORT` environment variables. On startup the bridge
prints its choice, e.g. `[jarvis] model claude-opus-5 · effort medium`.

### The voice pipeline

Space enters listening immediately after initialization, with no greeting. One
shared microphone uses echo cancellation and noise suppression. There is no
microphone capture before initialization unless you explicitly authorize the
offline double-clap gate (or the browser has already granted it). WebGL loads
after the lightweight cinematic. The 3.2-second DOM/CSS/SVG presentation runs
alongside real initialization; chat and voice do not wait for it. Two sharp
claps 180–900 ms apart ignite JARVIS, then clap analysis retires immediately.
Browser autoplay policies still apply. Ambient startup music remains off.

**Voice Settings** configures optional ElevenLabs Scribe and Picovoice keys in
Windows CurrentUser DPAPI storage outside the repository. Scribe transcribes
commands/interruptions only, never standby room audio. Browser SpeechRecognition
remains the fallback (its service may send audio to the browser vendor). Modern
Chrome/Edge can use the shared audio track; older browsers may own internal
recognition capture. Missing microphone permission keeps typed chat available.

Optional Porcupine detects the built-in “Jarvis” keyword locally on one CPU
thread, then command recognition takes over. Its model downloads once when
configured and is cached by the SDK. The AccessKey is encrypted at rest but the
Web SDK necessarily receives it inside its worker at runtime. It is never saved
in localStorage, source, or configuration. AI/ElevenLabs keys remain backend-only.
Optional wake setup fails back to browser recognition without blocking startup.

**Voice Replies** defaults to **Always** for both typed and voice requests;
**Voice requests only** and **Off** are available. Responses stream sentences
through system speech by default. `VITE_USE_ELEVENLABS=true` opts into cloud TTS;
otherwise a configured cloud voice is only a rescue for failed native speech.
Kokoro remains explicitly optional. STOP/Escape cancel the same owned turn,
including queued audio. Native speech failure is reported instead of silently
waiting or contacting an unconfigured cloud service.

ECO retains the holographic 3D design with lazy loading, DPR 1, approximately
30 FPS while active, half-resolution bloom, and no chromatic aberration/noise.
Standby freezes after a short settling burst; hidden tabs render no frames.
First paint, shader initialization and graphics failure use an opaque dark
background. Camera and gestures remain opt-in. Press **D** for event-based
latest-interaction latency diagnostics; press **T** for an audio-only test.

Readiness describes configuration, not live provider validation. No provider
API polling, paid fallback, or automatic effectful request replay is added.
See [VOICE_PERFORMANCE.md](VOICE_PERFORMANCE.md) for details and limitations.

---

## What JARVIS can do

Beyond answering, JARVIS reaches every MCP server in your Claude Code
configuration, and can drive his own interface.

### Your tools

Every server in your `~/.claude.json` is handed to the SDK explicitly. Depending
on what you have installed, that is roughly:

- **Web & search** — `exa`, `serper`, `serpapi`
- **Images & video** — `higgsfield`, `openrouter-image`, `palmier-pro`
- **Voice** — `elevenlabs`
- **Your phone** — `android`
- **The browser** — `playwright`

A few things you can say:

- *"What's happening in AI this week?"*
- *"Generate an image of the Mark VII suit."*
- *"Take a screenshot of my phone."*
- *"Open my GitHub notifications."*

> **Note on account connectors.** Servers you added through your **claude.ai
> account** are not stored on disk, so the bridge cannot see them — it works from
> the servers in `~/.claude.json` (about 14), not the claude.ai ones.

### JARVIS controls the interface

He drives the UI through MCP tools the bridge exposes:

- `ui_theme` — accent, background, per-phase colours
- `ui_reactor` — colour, scale, intensity, spin, and style (`ring` | `sphere` | `wire`), visibility
- `ui_orbit` — put images in orbit around the reactor
- `ui_chrome` — show or hide rails, transcript, badges
- `ui_effect` — `glitch` | `pulse` | `scan` | `shake` | `flash`
- `ui_screen` — clear
- `ui_reset` — back to defaults

So *"make it red, hide the systems list, put that render in orbit"* is a spoken
command.

### The heads-up display

JARVIS authors panels with a `display` tool against a fixed `.hud-*` design
system. The browser sanitises the markup (DOMPurify, a class allowlist and a
strict CSP) before rendering. Rich media works — images, `<video>`, and
YouTube/Vimeo embeds. Remote images and video are fetched **server-side** through
the bridge (`/img` and `/media`, both SSRF-guarded), so hotlink-blocked news
thumbnails still appear and the page never beacons your IP to a host the model
chose.

---

## Controls

| Key / phrase | Does |
|---|---|
| **"Hey Jarvis"** | Wake him |
| **Space** | Talk without the wake word |
| Just speak | Interrupt him mid-sentence (barge-in) |
| **V** | Cycle the browser voice |
| **Escape** | Stand down |
| **D** | Live diagnostics panel |
| **T** | One-line audio self-test |

---

## The boot sequence

Power-up plays a four-beat Iron Man start-up (`src/ui/Boot.tsx`): an
"INITIATING SYSTEM" status bar with a segmented progress bar and boot log; then
concentric reticle rings resolving into "J.A.R.V.I.S"; then a suit schematic;
then the triangular arc reactor lighting up — with a start-up sound under it
(`public/audio/boot-music.mp3`).

---

## Configuration

Everything is optional in bridge mode. Frontend settings live in `.env.local`
(copy `.env.example`); bridge settings are environment variables.

### AI settings and typed chat

Open **AI Settings** to choose OpenRouter, OpenAI, Google Gemini or Claude Agent,
save separate Windows-protected provider keys, select
FAST/BALANCED/DEEP model mappings, and test the connection. Typed chat works
without enabling voice. Enter sends; STOP/Escape cancels. Claude Agent remains
available. Model catalogs load on request; OpenRouter offers search, Free only,
Vision and Tools filters plus explicit `openrouter/free` selection. See
[multi-provider setup and security](PHASE7.md) and
[OpenRouter details](OPENROUTER_SETTINGS.md).
Browser-direct AI credentials are retired.

### Bridge

| Variable | Default | Effect |
|---|---|---|
| `JARVIS_BRIDGE_PORT` | `8787` | Port for the WebSocket + HTTP endpoints |
| `JARVIS_MODEL` | `claude-opus-5` | Model to run |
| `JARVIS_EFFORT` | `medium` | Reasoning effort |
| `JARVIS_ALLOW_WRITES` | off | `1` allows effectful tools (see below) |
| `JARVIS_ALLOWED_ORIGINS` | local dev | Extra WebSocket origins to accept |
| `JARVIS_ALLOW_NO_ORIGIN` | off | Accept authenticated WebSockets with no `Origin` header |
| `JARVIS_FILE_ROOTS` | private artifacts | Extra narrow local artifact directories for `/file` |
| `JARVIS_VOICE_ID` | — | ElevenLabs voice id |
| `ELEVENLABS_API_KEY` | — | Optional; enables the ElevenLabs voice + Scribe |

### Frontend (`.env.local`)

| Variable | Effect |
|---|---|
| `VITE_BRIDGE_URL` | Local bridge port used by the Node broker; remote hosts are refused |
| `VITE_TTS_ENGINE` | `system` or `kokoro` |
| `VITE_KOKORO_VOICE` | Voice for the Kokoro engine |
| `VITE_USE_ELEVENLABS` | Force the ElevenLabs voice on |

### Adding an ElevenLabs key

You do not have to touch a flag. Either:

- Set `ELEVENLABS_API_KEY` on the bridge before starting it, **or**
- Add the key to your `elevenlabs` MCP server's env in `~/.claude.json` — the
  bridge reads it from there too.

Either way, authenticated `/readiness` reports speech as configured, the browser
picks it up on the next boot, and both voice and transcription are selected
automatically. External service access is validated by actual use.

---

## Enabling actions

The tool gate starts **read-only**. Search, generation and lookups run freely;
anything effectful — send, tap, delete, install, pay — is denied. Voice is a poor
interface for a confirmation dialog, so the decision is made ahead of time in
`decideTool()` in `bridge/server.mjs`, not at the moment of use. The bridge sets
`settingSources: []`, so filesystem settings and global allow-rules are not
loaded. This callback is not a complete
tool sandbox: SDK auto-approved tools can bypass it. A stronger tool-permission
architecture is a later phase.

To allow effectful tools (phone, browser driving, sending), run the bridge this
way instead:

```bash
npm run bridge:writes
```

> Read `decideTool()` before you do. *"Hey Jarvis, clean up my downloads folder"*
> means something rather different with writes enabled.

---

## Troubleshooting

**I can't hear him, or he can't hear me.** Press **D** for the diagnostics panel
— it states plainly whether he is hearing you and whether he is producing sound.
Press **T** for a one-line audio self-test.

**No voice at all.** You must be in **Chrome or Edge**, in a **real browser
window** (not an embedded preview), and you must have **allowed the microphone**.

**Bridge not reachable.** Check that `npm run bridge` is still running in its
terminal, and that nothing else is holding port `8787`.

---

## Local bridge security

The bridge binds explicitly to `127.0.0.1`. Both HTTP and WebSocket requests
validate the local Host, and sensitive requests require a randomly generated
bearer credential. `/health` is intentionally public and returns only
`{"ok":true}`; authenticated `/readiness` distinguishes configuration from actual
validation. It performs no periodic cloud checks or authentication probe.

Vite's local dev/preview broker initializes an HttpOnly, SameSite=Strict,
origin-bound browser session through a same-origin POST. It keeps the bridge
bearer on the Node side and forwards authenticated, streaming requests. The
bearer is never included in frontend bundles, URLs, localStorage, or logs.
Browser session cookies contain a derived credential, not the bridge bearer.
The browser must use this local dev/preview workflow in bridge mode; serving
the built frontend on an unrelated static host is not supported in bridge mode.
`VITE_BRIDGE_URL` can select a local bridge port, not a remote bridge host.

Private runtime records live beneath `%LOCALAPPDATA%\JarvisAI\bridge\<checkout-id>`
on Windows, or `~/.local/share/JarvisAI/bridge/<checkout-id>` elsewhere. Each
bridge port has a per-process credential, rotated at restart; stale records
with a dead PID are refused. File permissions use the private user-profile
directory and restrictive POSIX modes where supported. This protects against
LAN access and unrelated websites, not malware/admin processes running with
access to the same user's files/browser. Keep user-profile ACLs private.

`/file`, `/img`, `/media`, `/page`, `/tts`, `/stt`, `/readiness`, and WebSocket
`/`/`/ws` require authentication. Sandboxed reader images use ten-minute grants
bound to one `/img` URL; these grant no file, speech, or agent access. Referrers
are suppressed. URL schemes, private/loopback addresses, DNS rebinding,
redirects, size limits, DOMPurify, and realpath checks remain guarded.

Local images must be in the private runtime `artifacts` subfolder, or an existing
narrow directory explicitly listed in the bridge shell's `JARVIS_FILE_ROOTS`.
Home, temp, and drive roots are no longer approved. UNC/device paths are refused
before filesystem access. Tools that produce images elsewhere must be configured
to use an approved output directory, or that specific folder must be approved.
Do not place credentials or unrelated personal images in these directories.

Default limits are one agent/WebSocket session, eight authenticated HTTP requests,
six proxies/file reads, one STT request, and two TTS requests at a time, plus a
120-request/minute budget. `JARVIS_MAX_SESSIONS`, `JARVIS_MAX_HTTP`,
`JARVIS_MAX_PROXIES`, `JARVIS_MAX_STT`, `JARVIS_MAX_TTS`, and
`JARVIS_REQUESTS_PER_MINUTE` adjust them within bounded ranges. Excess work gets
429; WebSocket payloads and input queues are capped. Speech calls have deadlines.
Multiple tabs share this budget; raise the session limit deliberately if needed.

Logs retain operation/status information but omit raw URLs, credentials, upstream
error bodies, transcripts, and tool inputs. Run `npm run test:security` to check
the real local HTTP/WS transport and frontend broker using a test-only SDK double;
the suite does not contact a model or write personal conversation transcripts.

---

## Credits & licence

MIT.

The boot sound and any tracks in `public/audio/` ship with the project for the
demo. If you go on to monetise something built on this, clearing the rights to
that audio is your responsibility.
