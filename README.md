# Hosted Image Generator

Generate images with Google's **nano banana** models (via [fal.ai](https://fal.ai))
and **relay them through GitHub** so a network-restricted AI agent can fetch them.

The consuming agent (Claude in a Chat/Cowork code sandbox) has a locked outbound
allowlist — it can reach `raw.githubusercontent.com` but **not** fal.ai or its
output CDN. So this service downloads the generated image server-side, commits it
into a **public** GitHub repo, and returns a **commit-SHA-pinned**
`raw.githubusercontent.com` URL that the agent fetches with no auth token.

```
agent (chat) ──MCP──▶ this service
                        1. call fal.ai nano-banana with the prompt
                        2. receive fal output image URL
                        3. download the image bytes (server-side)
                        4. commit bytes to the public GitHub bucket (Contents API)
                        5. return { raw_url (SHA-pinned), commit_sha, model, ... }
agent ◀──MCP── raw_url
agent (sandbox): curl raw_url ▶ /tmp/img.png ▶ embed into .pptx / .docx
```

### Why a SHA-pinned URL?

Branch-based raw URLs (`.../main/...`) are CDN-cached for minutes, so a
just-pushed file 404s for a while. The `.../{COMMIT_SHA}/...` form is immutable
and fetchable **immediately** after the commit.

---

## Repository layout

```
src/
  fal.ts        # fal API wrapper (fetch-based, no SDK)
  github.ts     # Contents API commit → SHA-pinned raw URL
  relay.ts      # core: fal → download → commit → return contract (MCP-independent)
  mcp.ts        # McpAgent: the generate_image tool, wired to relay
  index.ts      # Worker entry: OAuth 2.1 provider wrapping the MCP server
scripts/
  gen.ts        # local CLI: `npm run gen -- "prompt"`
.github/workflows/
  prune.yml     # delete generated/ images older than N days
generated/      # the public image bucket (machine-generated; pruned)
  poc/          # proof-of-concept placeholder image
wrangler.toml
.env.example
```

`relay.ts` + `fal.ts` + `github.ts` are the standalone core. The MCP server and
the CLI are both thin wrappers, so the same logic can later drive a GitHub Action.

---

## Environment variables

| Variable          | Where                | Purpose                                                                 |
| ----------------- | -------------------- | ----------------------------------------------------------------------- |
| `FAL_KEY`         | secret               | fal.ai API key. Sent as `Authorization: Key <FAL_KEY>`.                 |
| `GITHUB_TOKEN`    | secret               | Fine-grained PAT, **Contents: Read+Write on the bucket repo only**.     |
| `MCP_AUTH_SECRET` | secret               | Gates the MCP OAuth consent screen. Anyone connecting must enter it.    |
| `GITHUB_OWNER`    | var (`wrangler.toml`)| Bucket repo owner. Default `rpriscu`.                                   |
| `GITHUB_REPO`     | var                  | Bucket repo name. Default `Hosted-Image-Generator`.                     |
| `GITHUB_BRANCH`   | var                  | Branch to commit into. Default `main`.                                  |

Secrets live **only** as Wrangler secrets (or, for local CLI, in a git-ignored
`.env`). They are never logged, echoed, or committed. See `.env.example`.

---

## Prerequisites

1. **The bucket repo must be PUBLIC.** This repo (`rpriscu/Hosted-Image-Generator`)
   is currently private — flip it to public in
   **Settings → General → Danger Zone → Change visibility**. A public repo lets the
   agent fetch raw content with no credential in the sandbox.
2. A fal.ai account with a key and a **commercial-use** tier if the output goes
   into client deliverables (confirm on your fal billing page).
3. A GitHub fine-grained PAT scoped to **Contents: Read and write** on this repo
   only.

---

## Local CLI (prove the relay without MCP)

```bash
npm install
cp .env.example .env        # fill in FAL_KEY and GITHUB_TOKEN
npm run gen -- "a wide minimal abstract navy tech hero background, 16:9"
```

Output is the JSON contract plus a ready-to-run curl:

```json
{
  "raw_url": "https://raw.githubusercontent.com/rpriscu/Hosted-Image-Generator/<sha>/generated/2026-06-05/<uuid>.png",
  "commit_sha": "<sha>",
  "model": "nano-banana-2",
  "prompt": "a wide minimal abstract navy tech hero background, 16:9",
  "content_type": "image/png",
  "bytes": 1234567
}
```

**Acceptance test #2** — the URL is fetchable immediately, no auth, correct type:

```bash
curl -sI "<raw_url>"
# HTTP/2 200
# content-type: image/png
```

CLI flags: `--model`, `--aspect`, `--resolution`, `--format`, `--hint`.

> The CLI runs TypeScript directly via Node's type-stripping (`node --env-file`).
> No build step.

---

## Deploy (Cloudflare Workers)

```bash
# 1. Create the KV namespace the OAuth provider uses, then paste the id into
#    wrangler.toml ([[kv_namespaces]] id = "...").
npx wrangler kv namespace create OAUTH_KV

# 2. Set secrets (never put these in wrangler.toml or .env that gets committed).
npx wrangler secret put FAL_KEY
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put MCP_AUTH_SECRET

# 3. Deploy.
npx wrangler deploy
```

This yields a URL like `https://hosted-image-generator.<your-account>.workers.dev`.
The MCP endpoint is that URL + **`/mcp`**.

---

## Connect it in Claude (custom connector)

Claude's connector UI authenticates remote MCP servers via **OAuth** (it has no
field for a static bearer header). This service ships a minimal OAuth 2.1 provider
whose consent screen is gated by `MCP_AUTH_SECRET`.

1. In Claude → **Settings → Connectors → Add custom connector**.
2. **Remote MCP server URL:** `https://hosted-image-generator.<your-account>.workers.dev/mcp`
3. Leave OAuth client id/secret blank — the server supports **dynamic client
   registration**, so Claude registers itself automatically.
4. Click **Connect**. You'll be redirected to the consent screen. **Enter your
   `MCP_AUTH_SECRET`** and authorize.
5. The `generate_image` tool is now available in chat.

> The chat agent **cannot** add its own connectors — you add it once in Settings.

### Worked example

In a chat with the connector enabled:

> "Generate a 16:9 abstract navy tech hero background and put it on slide 2."

Claude calls `generate_image`, receives `{ raw_url, ... }`, then (in its sandbox)
`curl`s the `raw_url` to `/tmp` and embeds the bytes into the `.pptx`.

---

## MCP tool contract

### `generate_image`

| Input           | Type / values                                            | Default        |
| --------------- | -------------------------------------------------------- | -------------- |
| `prompt`        | string (required)                                        | —              |
| `model`         | `nano-banana-2` \| `nano-banana-pro` \| `nano-banana`    | `nano-banana-2`|
| `aspect_ratio`  | e.g. `16:9`, `1:1`, `4:3`, `3:2`, `9:16`                 | `16:9`         |
| `resolution`    | `1K` \| `2K` \| `4K`                                     | `2K`           |
| `output_format` | `png` \| `jpeg` \| `webp`                                | `png`          |
| `filename_hint` | string (optional)                                        | —              |

**Output:** `{ raw_url, commit_sha, model, prompt, content_type, bytes }` —
`raw_url` is the SHA-pinned `raw.githubusercontent.com` URL.

On failure the tool returns a **structured error object**
(`{ ok: false, error: { kind, message, status, detail } }`), never a stack trace.

`edit_image` (prompt + `image_urls` via the `/edit` models) is **deferred** — the
relay core is already structured to support it.

---

## Pruning

`.github/workflows/prune.yml` deletes `generated/` files older than a configurable
retention window (default **14 days**) daily, and on manual `workflow_dispatch`
(override with the `retention_days` input). The POC placeholder and `README.md`
files are never pruned.

---

## Security notes

- Secrets exist only as Worker/Actions secrets (or a git-ignored `.env`); the
  real `.env` is never committed.
- The MCP endpoint is unreachable without completing OAuth + the shared secret,
  so nobody else can run up your fal bill.
- The image bucket is **public** but contains only generated images — never a
  token. The agent needs no credential to fetch.
- Images are **never** returned as base64 to the agent (a 2K/4K PNG is hundreds
  of thousands of tokens); only the short URL is returned.

---

## Notes & caveats

- **fal model IDs / schema evolve** — verify on the model's `/api` page before
  relying on a field. Current: `fal-ai/nano-banana-2` (default),
  `fal-ai/nano-banana-pro`, `fal-ai/nano-banana`.
- The Contents API supports files up to 100 MB, so multi-MB 4K PNGs commit fine.
- Wrangler v3 is pinned here and builds cleanly; `wrangler@4` is available if you
  want the newest CLI.
