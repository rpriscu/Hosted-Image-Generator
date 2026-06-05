/**
 * relay.ts — the core, MCP-independent pipeline:
 *
 *   fal.ai generate  ->  download image bytes (server-side)  ->  commit to the
 *   public GitHub bucket  ->  return a SHA-pinned raw.githubusercontent.com URL.
 *
 * This module depends only on Web-standard APIs (fetch, crypto.randomUUID, btoa)
 * plus a Node fallback for base64, so it runs unchanged on Cloudflare Workers,
 * a Node CLI, or a GitHub Action.
 */

import { falGenerate, FalError, type FalModel } from "./fal.ts";
import { commitFile, GithubError } from "./github.ts";

export interface RelayConfig {
  falKey: string;
  githubToken: string;
  owner: string;
  repo: string;
  branch: string;
}

export interface GenerateImageInput {
  prompt: string;
  model?: FalModel;
  aspect_ratio?: string;
  resolution?: string;
  output_format?: "png" | "jpeg" | "webp";
  filename_hint?: string;
}

export interface GenerateImageOutput {
  raw_url: string;
  commit_sha: string;
  model: FalModel;
  prompt: string;
  content_type: string;
  bytes: number;
}

/** A structured error object — safe to return to a client (no secrets, no stack). */
export interface RelayErrorObject {
  ok: false;
  error: {
    kind: "fal" | "github" | "input" | "internal";
    message: string;
    status?: number;
    detail?: unknown;
  };
}

const DEFAULTS = {
  model: "nano-banana-2" as FalModel,
  aspect_ratio: "16:9",
  resolution: "2K",
  output_format: "png" as const,
};

const EXT: Record<string, string> = { png: "png", jpeg: "jpg", webp: "webp" };
const CONTENT_TYPE: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/** Portable base64 of binary bytes — Node Buffer when present, else chunked btoa. */
function bytesToBase64(bytes: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(e: string): string } } }).Buffer;
  if (B) return B.from(bytes).toString("base64");
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Make a filesystem/URL-safe slug from a user hint, capped in length. */
function slugify(hint: string): string {
  return hint
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Run the full relay. Throws FalError / GithubError on failure (use
 * `toErrorObject` at the boundary to convert to a structured response).
 */
export async function generateImage(
  input: GenerateImageInput,
  cfg: RelayConfig,
): Promise<GenerateImageOutput> {
  const prompt = input.prompt?.trim();
  if (!prompt) {
    throw new RelayInputError("`prompt` is required and must be non-empty");
  }

  const model = input.model ?? DEFAULTS.model;
  const output_format = input.output_format ?? DEFAULTS.output_format;

  // 1. + 2. Call fal and get a remote image URL.
  const result = await falGenerate(
    {
      prompt,
      model,
      aspect_ratio: input.aspect_ratio ?? DEFAULTS.aspect_ratio,
      resolution: input.resolution ?? DEFAULTS.resolution,
      output_format,
      num_images: 1,
    },
    cfg.falKey,
  );

  const image = result.images[0];

  // 3. Download the bytes server-side (never base64 back to the agent).
  let bytes: Uint8Array;
  try {
    const dl = await fetch(image.url);
    if (!dl.ok) {
      throw new FalError(`failed to download fal image (HTTP ${dl.status})`, dl.status);
    }
    bytes = new Uint8Array(await dl.arrayBuffer());
  } catch (e) {
    if (e instanceof FalError) throw e;
    throw new FalError(`failed to download fal image: ${(e as Error).message}`);
  }

  // 4. Commit to the public bucket.
  const ext = EXT[output_format] ?? "png";
  const content_type = image.content_type ?? CONTENT_TYPE[output_format] ?? "image/png";
  const id = crypto.randomUUID();
  const namePrefix = input.filename_hint ? `${slugify(input.filename_hint)}-` : "";
  const path = `generated/${todayUtc()}/${namePrefix}${id}.${ext}`;

  const commit = await commitFile({
    owner: cfg.owner,
    repo: cfg.repo,
    branch: cfg.branch,
    path,
    contentBase64: bytesToBase64(bytes),
    message: `Add generated image ${path}`,
    token: cfg.githubToken,
  });

  // 5. Return the SHA-pinned contract.
  return {
    raw_url: commit.raw_url,
    commit_sha: commit.commit_sha,
    model,
    prompt,
    content_type,
    bytes: bytes.length,
  };
}

/** Bad input (caller's fault), distinct from upstream fal/github failures. */
export class RelayInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayInputError";
  }
}

/** Convert any thrown error into a structured, secret-free error object. */
export function toErrorObject(e: unknown): RelayErrorObject {
  if (e instanceof FalError) {
    return { ok: false, error: { kind: "fal", message: e.message, status: e.status, detail: e.detail } };
  }
  if (e instanceof GithubError) {
    return { ok: false, error: { kind: "github", message: e.message, status: e.status, detail: e.detail } };
  }
  if (e instanceof RelayInputError) {
    return { ok: false, error: { kind: "input", message: e.message } };
  }
  return { ok: false, error: { kind: "internal", message: (e as Error)?.message ?? "unknown error" } };
}
