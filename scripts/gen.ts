/**
 * Local CLI for testing the relay without the MCP layer.
 *
 *   npm run gen -- "a wide minimal abstract navy tech hero background, 16:9"
 *   npm run gen -- "logo on white" --model nano-banana-pro --aspect 1:1 --resolution 4K --format png --hint client-logo
 *
 * Reads FAL_KEY / GITHUB_TOKEN / GITHUB_* from .env (loaded via `node --env-file`).
 * Prints the JSON contract and a ready-to-run curl command for acceptance test #2.
 */

import { generateImage, toErrorObject, type GenerateImageInput } from "../src/relay.ts";
import type { FalModel } from "../src/fal.ts";

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name} (set it in .env)`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const args = process.argv.slice(2);
  // The prompt is the first token that is neither a `--flag` nor a flag's value.
  const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  const finalPrompt = positional[0];

  if (!finalPrompt) {
    console.error('Usage: npm run gen -- "<prompt>" [--model ...] [--aspect 16:9] [--resolution 2K] [--format png] [--hint name]');
    process.exit(1);
  }

  const input: GenerateImageInput = {
    prompt: finalPrompt,
    model: getFlag(args, "model") as FalModel | undefined,
    aspect_ratio: getFlag(args, "aspect"),
    resolution: getFlag(args, "resolution"),
    output_format: getFlag(args, "format") as GenerateImageInput["output_format"],
    filename_hint: getFlag(args, "hint"),
  };

  const cfg = {
    falKey: requireEnv("FAL_KEY"),
    githubToken: requireEnv("GITHUB_TOKEN"),
    owner: process.env.GITHUB_OWNER ?? "rpriscu",
    repo: process.env.GITHUB_REPO ?? "Hosted-Image-Generator",
    branch: process.env.GITHUB_BRANCH ?? "main",
  };

  try {
    const out = await generateImage(input, cfg);
    console.log(JSON.stringify(out, null, 2));
    console.log("\n# Acceptance test #2 — should return HTTP/2 200 + content-type image/* with no auth:");
    console.log(`curl -sI "${out.raw_url}"`);
  } catch (e) {
    console.error(JSON.stringify(toErrorObject(e), null, 2));
    process.exit(1);
  }
}

main();
