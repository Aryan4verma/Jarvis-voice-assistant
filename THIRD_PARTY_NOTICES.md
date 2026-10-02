# Third-party notices and distribution limits

Audit date: 2026-10-02. Versions below match the installed packages and lockfile.
Evidence comes from package metadata, included licenses and `package-lock.json`;
missing license files are identified explicitly. `npm ci` installs components
under their own terms. The project MIT license does not replace those terms.

## Direct production dependencies

| Dependency | Locked version | Declared terms | Evidence / retained notice |
| --- | --- | --- | --- |
| `@anthropic-ai/claude-agent-sdk` | 0.3.220 | Vendor terms; not MIT | [Installed vendor notice](third-party-licenses/anthropic-agent-sdk.txt); metadata says SEE LICENSE IN README.md. See vendor terms below. |
| `@anthropic-ai/sdk` | 0.115.0 | MIT | [Full license](third-party-licenses/anthropic-sdk.txt); Anthropic. |
| `@mediapipe/tasks-vision` | 1.0.1 | Apache-2.0 | Metadata declaration; no LICENSE/NOTICE in installed package. [License text](third-party-licenses/Apache-2.0.txt); native runtime review remains. |
| `@picovoice/porcupine-web` | 4.0.1 | Apache-2.0 wrapper declaration | No standalone license in tarball; bundled headers retain Copyright 2021, 2022–2023 and 2022–2025 Picovoice Inc. [License text](third-party-licenses/Apache-2.0.txt); engine/service terms below. |
| `@picovoice/web-voice-processor` | 4.0.10 | Apache-2.0 | Installed LICENSE matches [license text](third-party-licenses/Apache-2.0.txt); Picovoice Inc. |
| `@react-three/drei` | 10.7.7 | MIT | [Full license](third-party-licenses/react-three-drei.txt). |
| `@react-three/fiber` | 9.7.0 | MIT | Metadata declares MIT but tarball omits LICENSE. [Official upstream license](third-party-licenses/react-three-fiber.txt), fetched from upstream master; not evidence of a version-specific bundled notice. |
| `@react-three/postprocessing` | 3.0.4 | MIT | [Full license](third-party-licenses/react-three-postprocessing.txt). |
| `dompurify` | 3.4.12 | (MPL-2.0 OR Apache-2.0) | Installed dual-license declaration. [Apache-2.0](third-party-licenses/Apache-2.0.txt) / [MPL-2.0](third-party-licenses/DOMPurify-MPL-2.0.txt). Apache is a documented distribution option; do not relabel the dependency MIT. |
| `framer-motion` | 12.43.0 | MIT | [Full license](third-party-licenses/framer-motion.txt). |
| `kokoro-js` | 1.2.1 | Apache-2.0 wrapper | Installed LICENSE matches [license text](third-party-licenses/Apache-2.0.txt); hexgrad. Embedded phonemizer/model terms below. |
| `react` | 19.2.8 | MIT | [Full license](third-party-licenses/react.txt). |
| `react-dom` | 19.2.8 | MIT | [Full license](third-party-licenses/react-dom.txt). |
| `three` | 0.185.1 | MIT | [Full license](third-party-licenses/three.txt). |
| `ws` | 8.21.1 | MIT | [Full license](third-party-licenses/ws.txt). |
| `zod` | 4.4.3 | MIT | [Full license](third-party-licenses/zod.txt). |
| `zustand` | 5.0.14 | MIT | [Full license](third-party-licenses/zustand.txt). |

Full MIT copyright/permission texts are retained because attribution tables alone
are not substitutes for them. The common Apache-2.0 text is included once rather
than duplicated across packages. DOMPurify's installed Apache license is the
same standard text apart from terminal whitespace. Copied license documents
are unmodified. `third-party-licenses/` records those texts; generated `/legal/`
contains these notices, attribution, the original project license and copies for
normal Vite workflows. This notice set is **not** a complete transitive binary
bill of materials or certification of a compiled release.

DOMPurify retains **(c) Cure53 and other contributors**, as its source license
header states. The Anthropic API SDK also vendors `qs`; its separate
[BSD notice](third-party-licenses/anthropic-sdk-qs.txt) is copied from the
installed `src/internal/qs/LICENSE.md`. Preserve that notice with the vendored
component rather than treating every file in the SDK as MIT-only.

## Vendor terms: Claude Agent

The installed SDK LICENSE says **© Anthropic PBC. All rights reserved**, referring
to [legal/compliance terms](https://code.claude.com/docs/en/legal-and-compliance).
It is not an MIT package despite this project's MIT code. The optional platform
SDK/CLI binary packages have separate vendor notices. The official SDK source
[license](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/LICENSE.md)
also refers to vendor terms. Do not modify/relicense the Claude binary or bundle
it as an MIT asset. Preserve authentication and vendor notices; check the
applicable Anthropic agreements before redistributing or hosting it. Each user
authenticates independently through the vendor flow. The existing adapter is
retained; no redistribution approval is asserted.

## Optional wake engine

The Porcupine wrapper declares Apache-2.0, consistent with the pinned upstream
[v4.0 license](https://github.com/Picovoice/porcupine/blob/v4.0/LICENSE).
Wrapper code licensing is not proof of unrestricted rights to every engine,
model or AccessKey-based service. Read [Picovoice terms](https://picovoice.ai/terms/)
for the intended use and downloaded artifacts. The model is downloaded only for
configured optional wake detection, not stored in Git. No engine or model has
been removed or replaced based solely on an unfamiliar license.

## Optional neural TTS: unresolved embedded-component issue

`kokoro-js@1.2.1` and `phonemizer@1.2.1` declare Apache-2.0. However phonemizer
contains embedded **eSpeak NG**, whose upstream [COPYING](https://github.com/espeak-ng/espeak-ng/blob/master/COPYING)
is GPLv3. The wrapper [repository](https://github.com/xenova/phonemizer.js) identifies
eSpeak NG but its package license alone does not establish the embedded WASM's
licensing/source compliance. Existing production builds emit this optional
phonemizer inside the Kokoro chunk even when system speech is the default.

**Distribution review required:** establish the exact compiled eSpeak source,
license notices, corresponding-source/build requirements and consequences for
combined bundle distribution before publishing that chunk/installer as MIT-only.
No conclusion that the whole project must be relicensed is made here. Source
code/dependency declarations are retained; no voice architecture or dependency
was removed in this task. Lazy loading reduces runtime cost, not obligations for
binaries that are actually distributed.

The separately downloaded [Kokoro ONNX model card](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)
declares Apache-2.0; that does not replace embedded-runtime terms or independently
verify every voice-data source. Models are not committed or repackaged here.

## Other transitive/native components

- Lock metadata identifies LGPL-3.0-or-later `sharp`/libvips platform components,
  including the installed Windows x64 package. Its README also lists sublibrary
  licenses. Keep license/source/relinking obligations when distributing those
  native libraries; do not infer MIT from the calling JS package.
- `webgl-constants@1.1.1` lacks a license field in lock metadata, but its installed
  README and [LICENSE](third-party-licenses/webgl-constants.txt) say MIT. That
  resolves the metadata-only missing-license finding.
- Other transitive declarations include BSD, ISC, Zlib, Unlicense, BlueOak-1.0.0
  and dual MIT/CC0. They are not removed just because the names differ from MIT.
  Review the exact shipped dependency graph, native/WASM inclusions and upstream
  NOTICE/source requirements for a packaged release. This direct audit does not
  certify all transitive notices as complete.
- MediaPipe supplies native WASM without a standalone LICENSE/NOTICE; its Apache
  declaration and [upstream license](https://github.com/google-ai-edge/mediapipe/blob/master/LICENSE)
  are documented, but embedded component notices require further release review.

## Fonts, assets and provider services

Chakra Petch and JetBrains Mono are served through Google Fonts, not bundled font
files. Their official OFL 1.1 copyright/license texts are retained:
[Chakra Petch](third-party-licenses/Chakra-Petch-OFL.txt) (The Chakra Petch Project
Authors, 2018) and [JetBrains Mono](third-party-licenses/JetBrains-Mono-OFL.txt)
(The JetBrains Mono Project Authors, 2020). Source: official Google Fonts family
OFL files linked in [ASSET_AUDIT.md](ASSET_AUDIT.md). Preserve these licenses if
later packaging fonts locally; the project MIT license does not cover them.

No recorded music, commercial movie images, downloaded screenshots or copied
armor models are in the current tracked tree. See [ASSET_AUDIT.md](ASSET_AUDIT.md)
for removed recordings and historical provenance limits. Private overrides or
AI/tool-generated media have separate rights; reviewing Git alone does not clear
content copied into a build.

OpenAI, Gemini, OpenRouter, Anthropic, ElevenLabs and Picovoice services retain
their own account, billing, usage and privacy terms. A REST adapter does not grant
rights to their trademarks or generated/returned content. No affiliation or
endorsement agreement is asserted. These notices give no legal certainty about
the JARVIS name or franchise-inspired design history.
