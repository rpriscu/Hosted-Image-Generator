/**
 * GitHub Contents API wrapper — commits a file and returns a COMMIT-SHA-PINNED
 * raw.githubusercontent.com URL.
 *
 * Why SHA-pinned: branch-based raw URLs (`.../refs/heads/main/...`) are served
 * from a CDN that caches for minutes, so a just-pushed file 404s for a while.
 * The `.../{COMMIT_SHA}/...` form is immutable and fetchable immediately.
 *
 * The Contents API supports files up to 100 MB, so multi-MB 2K/4K PNGs commit
 * fine here — no Git Data/blob API needed.
 */

export interface GithubCommitParams {
  owner: string;
  repo: string;
  branch: string;
  /** Repo-relative path, e.g. "generated/2026-06-05/uuid.png". */
  path: string;
  /** File bytes, base64-encoded (Contents API requirement). */
  contentBase64: string;
  message: string;
  token: string;
}

export interface GithubCommitResult {
  commit_sha: string;
  path: string;
  raw_url: string;
}

export class GithubError extends Error {
  readonly status?: number;
  readonly detail?: unknown;
  constructor(message: string, status?: number, detail?: unknown) {
    super(message);
    this.name = "GithubError";
    this.status = status;
    this.detail = detail;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 500);
  }
}

/** Encode each path segment but keep "/" separators. */
function encodePath(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

export async function commitFile(
  p: GithubCommitParams,
): Promise<GithubCommitResult> {
  const api = `https://api.github.com/repos/${p.owner}/${p.repo}/contents/${encodePath(p.path)}`;

  let res: Response;
  try {
    res = await fetch(api, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${p.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "hosted-image-generator",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: p.message,
        content: p.contentBase64,
        branch: p.branch,
      }),
    });
  } catch (e) {
    throw new GithubError(`Network error calling GitHub: ${(e as Error).message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GithubError(
      `GitHub commit failed (HTTP ${res.status})`,
      res.status,
      safeParse(text),
    );
  }

  const data = (await res.json().catch(() => null)) as {
    commit?: { sha?: string };
    content?: { path?: string };
  } | null;

  const sha = data?.commit?.sha;
  if (!sha) {
    throw new GithubError("GitHub response missing commit sha", res.status, data);
  }

  const path = data?.content?.path ?? p.path;
  const raw_url = `https://raw.githubusercontent.com/${p.owner}/${p.repo}/${sha}/${encodePath(path)}`;

  return { commit_sha: sha, path, raw_url };
}
