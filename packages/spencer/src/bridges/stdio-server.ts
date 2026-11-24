/** A tiny stdio MCP server over the SDK's low-level `Server` (plain JSON Schema tools, no zod). */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";
import { isBinary } from "../sea.ts";
import { spencerVersion } from "../version.ts";

/** How to run `spencer <sub…>` from this install: the binary itself, or node with main.ts from a checkout. */
export function selfCommand(sub: string[]): { command: string; args: string[] } {
  return isBinary()
    ? { command: process.execPath, args: sub }
    : { command: process.execPath, args: [fileURLToPath(new URL("../main.ts", import.meta.url)), ...sub] };
}

export interface BridgeTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, object>; required?: string[] };
  run(args: Record<string, unknown>): Promise<string>;
}

/** Thrown by a tool for an error the model should see (and maybe fix). */
export class ToolError extends Error {}

export async function serveStdio(name: string, instructions: string, tools: () => BridgeTool[]): Promise<void> {
  const server = new Server({ name, version: spencerVersion() }, { capabilities: { tools: {} }, instructions });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = tools().find((t) => t.name === req.params.name);
    if (!tool) return { content: [{ type: "text", text: `unknown tool ${req.params.name}` }], isError: true };
    try {
      return { content: [{ type: "text", text: await tool.run((req.params.arguments ?? {}) as Record<string, unknown>) }] };
    } catch (e) {
      return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
}

export function str(args: Record<string, unknown>, key: string, required: true): string;
export function str(args: Record<string, unknown>, key: string, required?: false): string | undefined;
export function str(args: Record<string, unknown>, key: string, required = false): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new ToolError(`${key} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new ToolError(`${key} must be a string`);
  return v;
}

export function int(args: Record<string, unknown>, key: string, def: number, min: number, max: number): number {
  const v = args[key];
  if (v === undefined || v === null) return def;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new ToolError(`${key} must be a number`);
  return Math.min(max, Math.max(min, Math.round(n)));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
