# CLAUDE.md — Hosted Image Generator

Context for continuing this project locally. Read this first.

## What this is

A remote service that generates images with Google's **nano banana** models (via
**fal.ai**) and **relays them through GitHub** so a network-restricted AI agent
(Claude in a Chat/Cowork sandbox) can fetch them.

**The single constraint that drives the whole design:** the consuming agent's
sandbox has a locked outbound allowlist — it CAN reach `raw.githubusercontent.com`
but CANNOT reach fal.ai or its CDN. So this service downloads the generated image
server-side, commits it into a **public** GitHub repo, and returns a
**commit-SHA-pinned** `raw.githubusercontent.com` URL (immutable + immediately
fetchable; branch URLs are CDN-cached for minutes and would 404).

Hard rules: image bytes travel through GitHub; return a SHA-pinned raw URL (never
branch-based); never return base64 to the agent (only the short URL); bucket repo
must be public (no token in the sandbox).

End goal: in chat say "generate a 16:9 navy tech hero background and put it on
slide 2" → Claude calls `generate_image` → gets `raw_url` → curls it → embeds into
.pptx/.docx. Later: wrap as a Skill.

## Architecture

Core pipeline (`src/relay.ts`, MCP-independent): fal call → server-side download →
commit to GitHub via Contents API → return SHA-pinned raw URL. The MCP server and
the CLI are thin wrappers over it (so a GitHub Action could drive it later too).

Stack: TypeScript on **Cloudflare Workers** (Wrangler), deployed as a remote
Streamable-HTTP MCP server. fal and GitHub are called with plain `fetch` (no SDKs).

## File map

- `src/fal.ts` — fal API wrapper (fetch-based). Sync endpoint `https://fal.run/{model}`, auth `Authorization: Key <FAL_KEY>`. Model aliases → `fal-ai/nano-banana-2|nano-banana-pro|nano-banana`. Throws `FalError`.
- `src/github.ts` — Contents API PUT; returns `{ commit_sha, path, raw_url }` (raw_url is SHA-pinned). Throws `GithubError`.
- `src/relay.ts` — `generateImage(input, cfg)` orchestrates the pipeline; `toErrorObject(e)` converts thrown errors to a structured `{ ok:false, error:{ kind, message, status, detail } }`. Path convention `generated/{YYYY-MM-DD}/{uuid}.{ext}`. Portable base64 (Node Buffer / chunked btoa).
- `src/mcp.ts` — `ImageMcp` (McpAgent) exposing the `generate_image` tool; defines `Env`. Thin wrapper over relay.
- `src/index.ts` — Worker entry: `@cloudflare/workers-oauth-provider` wrapping the MCP server; consent screen gated by `MCP_AUTH_SECRET`.
- `scripts/gen.ts` — local CLI (`npm run gen -- "prompt"`).
- `.github/workflows/prune.yml` — deletes `generated/` files older than N days (default 14), spares `poc/` and READMEs.
- `generated/poc/navy-hero-poc.png` — POC placeholder (1280×720 navy gradient).
- `wrangler.toml` — vars + DO binding `MCP_OBJECT` (class `ImageMcp`, SQLite migration) + KV `OAUTH_KV` (id placeholder to fill).
- `.env.example` — documents env vars (real `.env` is git-ignored).

## MCP tool contract — `generate_image`

Inputs: `prompt` (required); `model` (`nano-banana-2` default | `nano-banana-pro` | `nano-banana`); `aspect_ratio` (default `16:9`); `resolution` (`1K`|`2K`|`4K`, default `2K`); `output_format` (`png` default |`jpeg`|`webp`); `filename_hint` (optional).
Output: `{ raw_url, commit_sha, model, prompt, content_type, bytes }`.
On failure returns the structured error object (never a stack trace).

## Access control (how fal spend is protected)

The Worker URL is public, but `/mcp` requires a valid OAuth access token → 401
without it. The ONLY way to mint a token is the `/authorize` consent screen, which
requires entering **`MCP_AUTH_SECRET`**. So: anyone who knows that secret can use
the tool; keep it private = only you. `FAL_KEY` lives only as a Worker secret,
never exposed to the client or the repo. The secret is entered once at connect
time (not per call). No rate-limiting in code yet — set a spend cap on the fal
dashboard as a backstop; use a long random secret (`openssl rand -hex 32`); rotate
via `wrangler secret put MCP_AUTH_SECRET` if leaked.

## Decisions already made (confirmed by owner)

1. Bucket repo = **this repo** (`rpriscu/Hosted-Image-Generator`), made **public**. Images under `generated/`.
2. Auth = **OAuth 2.1 shim** (Claude connector UI can't set a static bearer header — confirmed limitation).
3. Scope now = `generate_image` + CLI + prune only. `edit_image` and Actions-trigger mode **deferred** (relay is structured to add them).
4. Format = PNG default, allow jpeg/webp. Default model `nano-banana-2` @ `2K`.

## Current state

- All code written, typechecked (`tsc` clean), and `wrangler deploy --dry-run`
  bundles with all bindings. Committed + pushed to `main` (default branch) and
  `claude/dazzling-ptolemy-Xsh9x`.
- Repo is **public**; `main` is the **default branch**; `GITHUB_BRANCH=main` matches.
- POC verified: the placeholder PNG returns `HTTP/2 200` + `content-type: image/png`
  with no auth from `raw.githubusercontent.com` (SHA-pinned URL).
- Structured-error path verified (fal error returned as a clean object).
- NOT yet done: a real fal generation (the cloud build env blocks `fal.run`),
  deployment, and connecting in Claude.

## Next steps (run locally — this is why you're continuing on your machine)

A. Get credentials: fal key (+ credits); GitHub fine-grained PAT scoped to
   **Contents: Read+Write on this repo only**.

B. Local smoke test (proves fal + commit + SHA URL before deploying):
   ```bash
   npm install
   cp .env.example .env        # paste FAL_KEY + GITHUB_TOKEN
   npm run gen -- "a wide minimal abstract navy tech hero background, 16:9"
   curl -sI "<raw_url from output>"   # expect HTTP/2 200 + content-type image/png
   ```
   Success = new file under `generated/<date>/` in the repo + a 200 raw URL.

C. Deploy to Cloudflare (free account needed):
   ```bash
   npx wrangler kv namespace create OAUTH_KV   # paste id into wrangler.toml
   npx wrangler secret put FAL_KEY
   npx wrangler secret put GITHUB_TOKEN
   npx wrangler secret put MCP_AUTH_SECRET     # your chosen password
   npx wrangler deploy                          # → https://hosted-image-generator.<acct>.workers.dev
   ```

D. Connect in Claude: Settings → Connectors → Add custom connector → URL =
   `https://…workers.dev/mcp` (leave client id/secret blank; it self-registers) →
   Connect → enter `MCP_AUTH_SECRET` on the consent screen. (The chat agent can't
   add its own connector — done once in Settings.)

E. Use it in chat: "Generate a 16:9 … and put it on slide 2."

F. Later: wrap as a Skill that teaches Claude when to call `generate_image` and to
   fetch + embed the `raw_url`. The tool contract is the stable surface.

## Commands

- `npm run gen -- "<prompt>" [--model …] [--aspect 16:9] [--resolution 2K] [--format png] [--hint name]` — local CLI
- `npm run typecheck` — `tsc --noEmit`
- `npm run dev` — `wrangler dev` (local Worker)
- `npm run deploy` — `wrangler deploy`

## Gotchas / notes

- CLI runs TS via Node type-stripping (`node --env-file=.env --experimental-strip-types`).
  Avoid TS **parameter properties** and enums in `src/*` and `scripts/*` — strip-only
  mode rejects them (esbuild/wrangler is fine, but the CLI breaks). Error classes
  use explicit field declarations for this reason.
- Relative imports use explicit `.ts` extensions (required by both type-stripping
  and the Bundler moduleResolution).
- `@cloudflare/workers-oauth-provider` requires a KV binding named `OAUTH_KV`.
  McpAgent default DO binding is `MCP_OBJECT`.
- A duplicate `@cloudflare/workers-types` (bundled by the provider) forces an `any`
  cast on the handlers in `src/index.ts` — intentional.
- Wrangler v3 is pinned and builds cleanly; v4 available if desired.
- fal model IDs / schemas evolve — verify on the model's `/api` page before relying
  on a field. Contents API supports files up to 100 MB (4K PNGs are fine).
