# Repository workflow

This project preserves the history and MIT attribution of `adewaskar/jarvis`.
Keep the original copyright, license notices, and useful documentation intact.

## Authorized Git workflow

- The primary working branch is `main`.
- `origin` is `https://github.com/Aryan4verma/Jarvis-voice-assistant.git`.
- `upstream` is the original `https://github.com/adewaskar/jarvis.git` repository.
- After a logical, successfully validated development milestone, inspect the
  diff, run the relevant checks, review staged files for private data, stage
  only appropriate project files, create a meaningful conventional commit,
  and push to `origin/main`. The owner authorizes this without repeated
  confirmation. Use one coherent commit per milestone.
- Never force-push, rewrite published history, delete branches or tags, or
  discard work with `git reset --hard` without explicit owner authorization.
- Inspect and reconcile remote changes safely; never overwrite them blindly.
- Do not automatically merge upstream changes into this customized project.
- If authentication requires interactive login, stop at that boundary and
  explain the required one-time step. Never expose credentials.

## Private data

Never commit API keys, tokens, passwords, private keys, authentication cookies,
secret environment files, personal-memory databases, private conversations,
recordings, temporary camera images, sensitive logs, machine-specific private
configuration, dependencies, or build caches. Ignore rules are a safeguard,
not a substitute for reviewing staged contents. Keep safe example configuration
and legitimate distributable project assets separate from private runtime data.

GitHub is source control, not live personal-memory storage. Do not add
third-party assets with unclear redistribution rights.
