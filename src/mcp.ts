/**
 * MCP layer — a thin McpAgent wrapper around the relay core.
 *
 * Exposes one tool, `generate_image`. Access is gated by the OAuth consent
 * screen in index.ts (the user must enter MCP_AUTH_SECRET), so the tool itself
 * trusts that it is only reachable post-authorization.
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { generateImage, toErrorObject } from "./relay.ts";

export interface Env {
  // secrets
  FAL_KEY: string;
  GITHUB_TOKEN: string;
  MCP_AUTH_SECRET: string;
  // vars
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_BRANCH: string;
  // bindings
  MCP_OBJECT: DurableObjectNamespace;
  OAUTH_KV: KVNamespace;
}

type Props = { userId: string };

export class ImageMcp extends McpAgent<Env, unknown, Props> {
  server = new McpServer({
    name: "hosted-image-generator",
    version: "1.0.0",
  });

  async init() {
    this.server.tool(
      "generate_image",
      "Generate an image with Google's nano banana models (via fal.ai) and relay it through GitHub. " +
        "Returns a commit-SHA-pinned raw.githubusercontent.com URL that a network-restricted agent can fetch " +
        "with no auth token. Use this for slide/document backgrounds, hero images, illustrations, etc.",
      {
        prompt: z
          .string()
          .min(1)
          .describe("What to generate, e.g. 'a wide minimal abstract navy tech hero background'"),
        model: z
          .enum(["nano-banana-2", "nano-banana-pro", "nano-banana"])
          .default("nano-banana-2")
          .describe("Model: nano-banana-2 (default, fast 1K/2K/4K); nano-banana-pro (highest fidelity); nano-banana (original)"),
        aspect_ratio: z
          .string()
          .default("16:9")
          .describe("Aspect ratio, e.g. 16:9, 1:1, 4:3, 3:2, 9:16"),
        resolution: z
          .enum(["1K", "2K", "4K"])
          .default("2K")
          .describe("Output resolution"),
        output_format: z
          .enum(["png", "jpeg", "webp"])
          .default("png")
          .describe("Image format. PNG (default) for lossless/transparency; jpeg/webp for smaller files"),
        filename_hint: z
          .string()
          .optional()
          .describe("Optional slug prepended to the filename for readability, e.g. 'slide2-hero'"),
      },
      async (args) => {
        try {
          const out = await generateImage(
            {
              prompt: args.prompt,
              model: args.model,
              aspect_ratio: args.aspect_ratio,
              resolution: args.resolution,
              output_format: args.output_format,
              filename_hint: args.filename_hint,
            },
            {
              falKey: this.env.FAL_KEY,
              githubToken: this.env.GITHUB_TOKEN,
              owner: this.env.GITHUB_OWNER,
              repo: this.env.GITHUB_REPO,
              branch: this.env.GITHUB_BRANCH,
            },
          );
          return {
            content: [{ type: "text" as const, text: JSON.stringify(out) }],
          };
        } catch (e) {
          // Structured error object, never a crash/stack trace.
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify(toErrorObject(e)) }],
          };
        }
      },
    );
  }
}
