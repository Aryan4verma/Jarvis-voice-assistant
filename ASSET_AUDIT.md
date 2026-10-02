# Asset and publishing audit

Reviewed 2026-10-02 against the complete tracked-file inventory, repository
history, source references, installed packages and locked dependency metadata.
This records evidence and limits, not a copyright/trademark guarantee.

## Tracked non-code assets

| Asset | Evidence / action |
| --- | --- |
| `public/audio/boot-music.mp3` | Removed. Original credits named *Impact Prelude*, but upstream commit `9e3413b` describes restoring a startup clip that says the assistant name. No matching license/source for that exact recording was established. |
| `public/audio/ambient.mp3` | Removed. Original credits named *Ossuary 6 – Air*, but `5fc8a86` / `9e3413b` describe a user-supplied replacement without an updated rights statement. |
| `public/audio/work.mp3` | Removed. Upstream credits named *Mechanolith* by Kevin MacLeod under CC BY 4.0; there was no direct source link or recording identity evidence sufficient to verify the actual bundled binary in this pass. |
| `public/favicon.svg` | Replaced the Vite logo with project-generated circles/crosshair/dark-square SVG geometry. No copied franchise/provider logo or external asset. Project MIT terms apply. |
| `src/assets/vite.svg` | Removed unused Vite starter logo; no source imports referenced it. |
| `public/wake-audio.js` | Project audio-worklet source; original MIT attribution remains. No recorded audio embedded. |
| Procedural core / reticle / UI icons | Source-generated GLSL, SVG, CSS and standard characters; retained. Historical franchise-inspired design does not establish trademark/design clearance; no copied armor mesh, movie image or texture file is in the current tracked tree. |

No tracked photos, screenshots, videos, font binaries, model weights or camera
captures were found. Documentation uses placeholder media examples, not bundled
media. A real music-video ID in a tool example was replaced with `VIDEO_ID`.
Removed binary assets remain accessible in existing Git history: history was not
rewritten. Current source archives no longer include them; do not package old
revisions or caches as cleared assets.

## External and generated resources

- CSS requests **Chakra Petch** and **JetBrains Mono** from Google Fonts; both
  official family license files declare SIL OFL 1.1. License/copyright copies
  are in `third-party-licenses/`: [Chakra Petch](https://github.com/google/fonts/blob/main/ofl/chakrapetch/OFL.txt)
  and [JetBrains Mono](https://github.com/google/fonts/blob/main/ofl/jetbrainsmono/OFL.txt).
  No font files are committed. Network font
  requests expose normal request metadata to Google; system fonts are fallbacks.
- `scripts/assets.mjs` copies the installed **MediaPipe tasks-vision 1.0.1** WASM
  runtime into ignored `public/mediapipe/` for development/build. Package metadata
  declares Apache-2.0, but that tarball lacks a standalone LICENSE/NOTICE. The
  Apache license is included in the notice set; a complete native/transitive
  notice/source audit is still required before standalone binary distribution.
- Optional hand tracking fetches Google's versioned `hand_landmarker.task` URL
  in `src/lib/hands.ts`. Weights are not committed. Package code licensing does
  not, by itself, establish rights to redistribute a separately downloaded model.
- Optional Porcupine uses the built-in Jarvis keyword and versioned Picovoice
  `porcupine_params.pv`. Installed wrapper metadata is Apache-2.0; the AccessKey,
  embedded engine and model/service terms need separate consideration. No copied
  model file or key is committed.
- Optional Kokoro fetches `onnx-community/Kokoro-82M-v1.0-ONNX` when selected.
  Its model card declares Apache-2.0. The JS wrapper, converted weights, voice
  data and embedded eSpeak NG are distinct components; see the unresolved
  distribution issue in THIRD_PARTY_NOTICES.md. No weights are committed.
- AI-generated panels/media, transcripts, microphone/camera data and user-created
  files are runtime content, not licensed assets supplied by this repository.
  Permission to display/download content is not permission to republish it.
- User-supplied MP3/WAV/etc. overrides are private and ignored. Build tools still
  copy files in `public/`; review that directory before sharing a build.

## Branding and release boundaries

README/package metadata, example prompts and comments now use holographic
assistant/system-core terminology. The JARVIS name and cyan procedural design
remain; original license/history remain. A more distinctive project name could
reduce franchise association, but no replacement name has been cleared. Possible
working names: **Cyan Relay**, **Quiet Circuit**, **Halo Desk**. No rename was made.

The upstream MIT notice has been preserved and direct dependency notices are
provided. This is not certification that every transitive/native binary, model,
service or trademark is cleared. Publish the source repository with these
notices; do not advertise `dist/`, vendor binaries or an installer as a fully
cleared MIT-only product until the outstanding distribution reviews are resolved.

## Privacy and verification

The original LICENSE Git blob matches the initial upstream revision exactly;
the working file was not edited. Origin/upstream remotes and authorship/history
are retained. No force-push or history rewrite is part of this pass.

A bounded credential-pattern scan examined 333 reachable Git blobs up to 5 MiB
and commit messages across local refs. One larger historical audio blob and
binary content are outside text scanning; asset provenance was reviewed
separately. No credential-pattern matches or private-looking historical paths
were found. This is a scoped scan, not proof that every possible secret is absent.
Current/staged files and generated frontend bundles receive a separate scan
before commit. No real credential values are printed. Existing private user
profile stores were not opened or altered.

Ignore probes cover environment files, DPAPI, copied settings, transcripts,
databases, captures/recordings/screenshots, private audio overrides and generated
legal notices. Build checks verify original notices/copies and absence of bundled
MP3 recordings. TypeScript, build, lint, JS syntax, the six existing test suites
(123 tests total) and diff checks pass. Existing optional-chunk warnings remain.
Two initial audit assertions needed Windows newline-aware comparisons; neither
was an application regression. No architecture/dependency change was required.
