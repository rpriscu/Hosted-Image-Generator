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

## Current state (updated 2026-06-05 — DEPLOYED & WORKING)

- **DEPLOYED & LIVE on Cloudflare Workers:**
  `https://hosted-image-generator.robert-priscu.workers.dev` — MCP endpoint `/mcp`.
  - CF account: robert.priscu@gmail.com, account id `6a99fb2f9011a2b89abd6d1bb278ff68`.
  - KV `OAUTH_KV` id `c244e2ee81c84c3e8abe57438d112594` (written into `wrangler.toml`, committed).
  - All three secrets set via `wrangler secret put`: `FAL_KEY`, `GITHUB_TOKEN`, `MCP_AUTH_SECRET`.
  - Deploy verified: `/mcp` → 401 without auth; `/authorize` → 200 (consent renders).
- **Real fal generations verified end-to-end** (the local CLI, not the cloud build env):
  - `nano-banana-2` 16:9 navy hero (commit `22c4801`).
  - `nano-banana-pro` 1:1 2K solution-architecture diagram (commit `56b5e63`) — matched the prompt well.
  - Both returned SHA-pinned raw URLs that fetch `HTTP/2 200` + `image/png` with no auth.
- Repo is **public**; `main` is the **default branch**; `GITHUB_BRANCH=main` matches.
- Structured-error path verified earlier (fal error returned as a clean object).

### BLOCKER on the MCP connector path (step D) — team account

The owner's Claude is on a **Team account where only the org admin can add custom
connectors**, so step D (Settings → add connector) is not self-serve. Key facts
established while diagnosing:
- The MCP connector is what bridges the sandbox allowlist (its traffic is proxied
  through Claude infra, NOT the sandbox network — so you can't just call the Worker
  URL from inside a team chat; the sandbox can't reach `workers.dev`).
- `MCP_AUTH_SECRET` gates the **per-user** `/authorize` consent screen. Tokens are
  user-scoped, so an org-wide connector would still make **each member** complete
  OAuth and enter the secret → there is **no "admin enters it once, shared by all"**.
  Org-wide + secret-stays-private are in tension *in the current design*.

### Current working mode: MANUAL BRIDGE (no connector)

Owner runs the **local CLI** to generate, then pastes the resulting `raw_url` into
the team chat; team-Claude curls it (`raw.githubusercontent.com` IS allowlisted) and
embeds into the deck. The fal/GitHub creds never touch the team chat. This is the
active workflow and needs no admin action.

## Next steps

A. ✅ DONE — credentials obtained (fal key + GitHub fine-grained PAT, Contents R+W).
   (Both were pasted into a chat session, so consider rotating: re-issue and
   `wrangler secret put FAL_KEY` / `GITHUB_TOKEN` to update the Worker — no redeploy.)

B. ✅ DONE — local smoke test passed (see Current state; two real generations verified).

C. ✅ DONE — deployed to Cloudflare (URL + bindings + secrets above; `/mcp` 401-gated).

D. ⛔ BLOCKED — custom connector requires an org admin on the owner's Team account.
   To unblock, EITHER:
   - Get the admin to enable member-added connectors OR add this one org-wide
     (URL `https://hosted-image-generator.robert-priscu.workers.dev/mcp`, leave
     client id/secret blank — it self-registers via dynamic client registration).
     NOTE: org-wide still makes each member enter `MCP_AUTH_SECRET` (per-user OAuth).
   - OR add it from a **personal** Pro/Max Claude account (self-serve, no admin).

   If going org-wide and you DON'T want to hand the secret to every member, the
   relay's access control must change: drop the consent-secret gate (auto-approve
   the OAuth consent) and protect fal spend instead with a **fal dashboard spend
   cap + an in-Worker daily request limit** (not yet implemented; `src/index.ts` is
   where the consent screen lives, `src/relay.ts`/`src/mcp.ts` for a rate counter).

E. ✅ ACTIVE WORKAROUND — manual bridge (see "Current working mode" above):
   `npm run gen -- "<prompt>"` → copy `raw_url` → paste into team chat → team-Claude
   fetches + embeds. No connector/admin needed.

F. Later: wrap as a Skill that teaches Claude when to call `generate_image` and to
   fetch + embed the `raw_url`. The tool contract is the stable surface. (Only
   useful once the connector path D is unblocked.)

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
