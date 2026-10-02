# JARVIS Voice Assistant

<p align="center">
  <strong>A lightweight, voice-first holographic AI assistant built for Windows.</strong>
</p>

<p align="center">
  Voice • Multi-Provider AI • Secure API Keys • Futuristic 3D UI • Low-End PC Optimized
</p>

<p align="center">
  <img
    width="959"
    height="441"
    alt="JARVIS Voice Assistant"
    src="https://github.com/user-attachments/assets/17ac785c-9222-4e40-b280-f36c6eccc271"
  />
</p>

<p align="center">
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT License" />
  </a>
  <img src="https://img.shields.io/badge/Platform-Windows-0078D6" alt="Windows" />
  <img src="https://img.shields.io/badge/Node.js-20.19%2B-339933" alt="Node.js" />
  <img src="https://img.shields.io/badge/React-Vite-61DAFB" alt="React + Vite" />
  <img src="https://img.shields.io/badge/AI-Multi--Provider-purple" alt="Multi Provider AI" />
</p>

---

## Overview

**JARVIS Voice Assistant** is a customized browser-based personal AI assistant with:

- voice interaction
- typed chat
- cinematic startup
- two-clap ignition
- holographic 3D visuals
- multiple cloud AI providers
- secure Windows credential storage
- cancellation-safe interaction handling
- low-resource rendering designed for everyday use on modest hardware

This repository is a modified derivative of
[Aditya Dewaskar's JARVIS](https://github.com/adewaskar/jarvis).

It is **not** a project created entirely from scratch.

See:

- [Attribution](ATTRIBUTION.md)
- [MIT License](LICENSE)
- [Third-Party Notices](THIRD_PARTY_NOTICES.md)
- [Asset Audit](ASSET_AUDIT.md)

---

# Features

## Voice-first interaction

JARVIS supports:

- **"Hey Jarvis"** wake interaction
- **Space** for fast push-to-talk
- typed chat with **Enter / Send**
- streaming AI responses
- streaming spoken responses
- STOP / Escape cancellation
- user barge-in while JARVIS is speaking
- browser speech fallback
- optional ElevenLabs STT/TTS
- optional Picovoice Porcupine wake detection

Voice Replies can be configured as:

- **Always**
- Voice requests only
- Off

By default, JARVIS can speak responses to both typed and spoken prompts.

---

## Cinematic startup

JARVIS includes a lightweight futuristic startup sequence.

Startup options include:

- **two-clap ignition**
- INITIALISE button
- Space shortcut

The boot sequence can show system-style initialization messages such as:

```text
WAKE SIGNAL CONFIRMED
INITIALIZING J.A.R.V.I.S.
SECURE BRIDGE ........ ONLINE
AI PROVIDER .......... READY
AUDIO SYSTEM ......... READY
VOICE INTERFACE ...... READY
GRAPHICS CORE ........ READY
SYSTEM INTEGRITY ..... NOMINAL
```

The visual sequence runs concurrently with actual initialization instead of forcing a long artificial startup delay.

> Browser microphone and autoplay permission rules still apply.

---

# AI Providers

JARVIS uses a provider-neutral AI architecture.

Supported provider modes include:

| Provider | Status |
|---|---|
| OpenRouter | Supported |
| OpenAI | Supported |
| Google Gemini | Supported |
| Claude Agent SDK | Supported |

Each API provider has its own secure credential slot.

Provider switching does not delete the saved credentials of other providers.

---

## Model Modes

JARVIS provides three logical AI modes:

### FAST

For:

- simple commands
- quick questions
- lower latency
- lower API cost

### BALANCED

Recommended for normal everyday JARVIS usage.

### DEEP

For:

- complex reasoning
- coding
- planning
- difficult questions

Actual model IDs can be selected independently for each provider.

---

# OpenRouter

OpenRouter supports:

- streaming responses
- model discovery
- vision capability detection
- tool capability detection
- FAST / BALANCED / DEEP mappings
- manual model IDs
- free-model filtering
- `openrouter/free`

The model selector can identify known free models using OpenRouter catalog pricing metadata.

JARVIS never silently changes a selected free model to a paid model.

---

# OpenAI

OpenAI is available as a backend AI provider.

Your API key is stored securely on your Windows machine and never returned to the browser after saving.

Use **AI Settings** to:

1. Select OpenAI.
2. Enter your API key.
3. Save it.
4. Load/select a model.
5. Configure FAST / BALANCED / DEEP.
6. Test the connection.

---

# Google Gemini

Gemini is also available through the same provider architecture.

It supports provider-specific model selection while using the same JARVIS:

- turn lifecycle
- cancellation
- streaming interface
- settings system
- security architecture

---

# Secure API Key Storage

AI credentials are **not** stored in the frontend.

On Windows, provider credentials are stored using:

**Windows CurrentUser DPAPI**

under local application data.

Conceptually:

```text
Browser UI
    ↓
Authenticated local bridge
    ↓
Windows DPAPI
    ↓
Provider API
```

Keys are never intentionally stored in:

```text
Git
localStorage
frontend JavaScript bundles
normal settings JSON
URLs
logs
SQLite
```

The UI only receives safe status information such as:

```text
OpenAI
✓ Key configured
```

The actual stored secret is never displayed again.

---

# Holographic Interface

The frontend uses:

- React
- Vite
- Three.js
- React Three Fiber
- custom GLSL shaders
- lightweight post-processing
- HUD overlays
- animated reactor/core visuals

The goal is to keep the interface visually impressive without continuously consuming unnecessary GPU resources.

---

## ECO Performance Mode

The default rendering policy is designed for low-end laptops.

Typical ECO behavior includes:

```text
DPR                 1
Active rendering    ~30 FPS
Dormant rendering   reduced/frozen
Hidden tab          rendering suspended
Chromatic effect    disabled/reduced
Noise               disabled/reduced
Camera              off by default
Gestures            off by default
```

The 3D scene is staged/lazy-loaded so browser startup does not need to initialize every expensive visual system immediately.

---

# Target Hardware

Development and optimization are focused on a Windows laptop in roughly this class:

```text
CPU       Intel Core i3-class
RAM       8 GB
GPU       Integrated graphics
OS        Windows 64-bit
```

These are **optimization targets**, not guaranteed minimum hardware requirements.

The actual AI models run in the cloud, so JARVIS does not require a large local LLM to remain loaded in RAM.

---

# Requirements

You need:

- Windows 64-bit recommended
- Node.js `^20.19.0 || >=22.12.0`
- npm
- Chrome or Microsoft Edge
- an AI provider account/API key

Optional integrations may require their own credentials.

---

# Installation

Clone the repository:

```powershell
git clone https://github.com/Aryan4verma/Jarvis-voice-assistant.git
cd Jarvis-voice-assistant
```

Install dependencies:

```powershell
npm ci
```

Optional environment/setup check:

```powershell
npm run setup
```

Start JARVIS:

```powershell
npm start
```

Open the local URL printed by the launcher.

Normally:

```text
http://localhost:5173
```

Use a **real Chrome or Edge window** rather than an embedded editor preview.

---

# Starting JARVIS

You can start JARVIS using:

### Option 1 — Double clap

After microphone permission has been granted:

```text
CLAP
CLAP
 ↓
JARVIS startup
```

The clap detector operates only while JARVIS is waiting for startup and is stopped afterward.

### Option 2 — INITIALISE

Click the startup button.

### Option 3 — Space

Press:

```text
Space
```

to initialize or enter push-to-talk.

---

# Voice Controls

| Control | Action |
|---|---|
| **Hey Jarvis** | Wake JARVIS |
| **Space** | Push-to-talk |
| **Enter / Send** | Submit typed message |
| **STOP** | Cancel current interaction |
| **Escape** | Cancel / stand down |
| **V** | Cycle system voices |
| **D** | Show latency diagnostics |
| **T** | Audio self-test |
| **G** | Optional hand interaction |

---

# Voice Architecture

The voice system is designed around reliability and low idle resource use.

Typical flow:

```text
Wake / Push-to-talk
        ↓
Microphone
        ↓
Speech recognition
        ↓
Selected AI Provider
        ↓
Streaming response
        ↓
Text display
        +
Speech output
```

Browser speech recognition remains available as a fallback.

Optional higher-quality speech components can be enabled separately.

---

# Cancellation and Reliability

Every user interaction receives its own immutable turn identity.

If a turn is cancelled:

```text
old AI output
old tool event
old speech
old camera result
old UI event
```

cannot later attach itself to a newer interaction.

STOP, Escape, barge-in, timeouts, and disconnects share the same interaction lifecycle.

This prevents common race conditions where an older request modifies the UI after a newer request has already started.

---

# Browser and Tool Support

JARVIS includes several tool/interface systems, but browser automation availability depends on the provider and environment.

| Mode | Tool capability |
|---|---|
| OpenRouter | JARVIS-supported application tools |
| OpenAI | JARVIS-supported application tools |
| Gemini | JARVIS-supported application tools |
| Claude Agent | Agent runtime + configured MCP tooling |

## Important Windows limitation

The existing custom Chrome transport still uses a Unix-style native-host socket mechanism:

```text
/tmp/claude-mcp-browser-bridge-<user>/<pid>.sock
```

Therefore native Windows Chrome/Edge automation through that custom transport is currently **incomplete/unverified**.

Claude Agent may still have access to independently configured MCP/browser tooling depending on the user's environment.

Do not assume that every provider can automatically control:

- Chrome
- YouTube
- email
- filesystem
- phone
- external applications

unless the corresponding JARVIS tool has actually been exposed and configured.

---

# Camera and Gestures

Camera functionality is optional.

JARVIS can support:

- image capture
- vision input
- recent-frame analysis
- optional hand interaction

Camera and gesture processing remain disabled unless explicitly enabled.

This avoids unnecessary background CPU/GPU use.

---

# Privacy

The local bridge binds to:

```text
127.0.0.1
```

rather than exposing JARVIS as a LAN service.

Sensitive bridge requests use authenticated local communication.

Private runtime information is kept outside the repository.

Examples of data excluded from Git include:

```text
.env files
API credentials
DPAPI secret blobs
databases
logs
recordings
camera captures
screenshots
local settings
transcripts
runtime caches
```

AI messages sent to cloud providers are still subject to the selected provider's own privacy and retention policies.

---

# Project Structure

A simplified overview:

```text
src/
├── App.tsx
├── scene/
│   ├── Scene.tsx
│   ├── Core.tsx
│   └── Particles.tsx
├── lib/
│   ├── brain.ts
│   ├── voice.ts
│   ├── tts.ts
│   ├── audio.ts
│   ├── turn.ts
│   └── capabilities.ts
└── ui/
    ├── Hud.tsx
    ├── Boot.tsx
    ├── ChatInput.tsx
    └── AISettings.tsx

bridge/
├── server.mjs
├── security.mjs
├── secrets.mjs
└── providers/
    ├── claude-agent.mjs
    ├── openrouter.mjs
    ├── openai.mjs
    └── gemini.mjs

shared/
└── AI contracts

tests/
├── security
├── lifecycle
├── providers
├── voice
└── startup
```

Exact filenames may evolve as development continues.

---

# Development Commands

TypeScript:

```powershell
npx tsc -b --pretty false
```

Build:

```powershell
npm run build
```

Lint:

```powershell
npm run lint
```

Security tests:

```powershell
npm run test:security
```

Lifecycle tests:

```powershell
npm run test:lifecycle
```

Provider tests:

```powershell
npm run test:providers
```

OpenRouter tests:

```powershell
npm run test:openrouter
```

Voice tests:

```powershell
npm run test:voice
```

Startup tests:

```powershell
npm run test:startup
```

---

# Known Limitations

The project is still a personal/local assistant rather than a production desktop platform.

Known limitations include:

- native Windows browser automation remains incomplete
- browser microphone/autoplay behavior depends on Chrome/Edge permission policy
- cloud providers can rate-limit or reject requests
- not every model supports tools or vision
- STOP can cancel supported work but cannot undo an external action that has already completed
- optional neural speech and gesture systems consume additional resources
- no persistent SQLite-based personal memory is currently implemented
- provider billing/quota depends on the user's own accounts
- live provider availability is not guaranteed by automated tests

Automated tests use deterministic doubles where possible and do not replace full real-device/provider testing.

---

# License and Attribution

This repository is based on:

**Aditya Dewaskar's JARVIS**

Original repository:

https://github.com/adewaskar/jarvis

The original project is distributed under the MIT License.

The original copyright notice is preserved in:

[LICENSE](LICENSE)

Additional project history and modification information:

[ATTRIBUTION.md](ATTRIBUTION.md)

Third-party dependency information:

[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

Asset review:

[ASSET_AUDIT.md](ASSET_AUDIT.md)

---

# Disclaimer

This is an independent open-source personal project.

It is **not affiliated with, sponsored by, or endorsed by**:

- Marvel
- Disney
- OpenAI
- Google
- Anthropic
- OpenRouter
- ElevenLabs
- Picovoice

Product and company names belong to their respective owners.

The name **JARVIS** is retained for this personal project. A disclaimer does not itself guarantee trademark clearance.

---

# Credits

Original project:

**Aditya Dewaskar**  
https://github.com/adewaskar/jarvis

Customized and extended by:

**Aryan Verma**

Major customization work includes:

- Windows compatibility improvements
- local bridge security
- cancellation-safe interaction lifecycle
- provider-neutral AI architecture
- OpenRouter integration
- OpenAI integration
- Gemini integration
- Windows DPAPI credential protection
- voice interaction improvements
- two-clap startup
- cinematic boot flow
- low-resource rendering
- typed chat
- diagnostics and testing improvements

---

<p align="center">
  <strong>JARVIS — online.</strong>
</p>

<p align="center">
  Built as a personal experiment in voice-first AI interaction.
</p>
