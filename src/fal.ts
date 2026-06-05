/**
 * fal.ai API wrapper — fetch-based, no SDK, runs on both Workers (V8) and Node.
 *
 * Uses fal's synchronous endpoint `https://fal.run/{model}`. Image generation for
 * nano-banana completes in a few seconds; awaiting a fetch does not consume Worker
 * CPU budget (only wall time on I/O), so the sync endpoint is fine here. If you
 * later need very long jobs, switch to the queue API (`https://queue.fal.run`).
 *
 * Schema verified against fal docs (nano-banana-2): input `prompt` (required),
 * `aspect_ratio`, `resolution` (0.5K|1K|2K|4K), `output_format` (jpeg|png|webp),
 * `num_images`. Output: `{ images: [{ url, content_type, file_name, ... }], description }`.
 */

export type FalModel = "nano-banana-2" | "nano-banana-pro" | "nano-banana";

/** Public model alias -> fal endpoint id. */
const MODEL_ENDPOINTS: Record<FalModel, string> = {
  "nano-banana-2": "fal-ai/nano-banana-2",
  "nano-banana-pro": "fal-ai/nano-banana-pro",
  "nano-banana": "fal-ai/nano-banana",
};

export interface FalGenerateParams {
  prompt: string;
  model: FalModel;
  aspect_ratio: string;
  resolution: string;
  output_format: "png" | "jpeg" | "webp";
  num_images?: number;
}

export interface FalImage {
  url: string;
  content_type?: string;
  file_name?: string;
  width?: number;
  height?: number;
}

export interface FalResult {
  images: FalImage[];
  description?: string;
}

/** Structured fal failure — never leaks the API key, carries status + sanitized detail. */
export class FalError extends Error {
  readonly status?: number;
  readonly detail?: unknown;
  constructor(message: string, status?: number, detail?: unknown) {
    super(message);
    this.name = "FalError";
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

/**
 * Call a nano-banana model and return its raw result (with a remote image URL).
 * The caller is responsible for downloading `images[0].url` server-side.
 */
export async function falGenerate(
  params: FalGenerateParams,
  falKey: string,
): Promise<FalResult> {
  const endpoint = MODEL_ENDPOINTS[params.model];
  if (!endpoint) {
    throw new FalError(`Unknown model: ${params.model}`);
  }

  const body: Record<string, unknown> = {
    prompt: params.prompt,
    aspect_ratio: params.aspect_ratio,
    output_format: params.output_format,
    num_images: params.num_images ?? 1,
    // The original `nano-banana` (Gemini 2.5 Flash) does not accept `resolution`;
    // the 2/pro families do. Sending it to the original is harmless (ignored).
    resolution: params.resolution,
  };

  let res: Response;
  try {
    res = await fetch(`https://fal.run/${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Key ${falKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new FalError(`Network error calling fal: ${(e as Error).message}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new FalError(
      `fal request failed (HTTP ${res.status})`,
      res.status,
      safeParse(text),
    );
  }

  const data = (await res.json().catch(() => null)) as FalResult | null;
  if (!data || !Array.isArray(data.images) || data.images.length === 0) {
    throw new FalError("fal returned no images", res.status, data);
  }
  if (!data.images[0].url) {
    throw new FalError("fal image is missing a url", res.status, data);
  }
  return data;
}
