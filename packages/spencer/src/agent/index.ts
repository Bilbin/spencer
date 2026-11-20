import type { AgentService, CoreServices } from "../contracts.ts";
import { SpencerAgent, type AgentOptions } from "./agent.ts";

export { SpencerAgent, type AgentOptions } from "./agent.ts";
export { McpManager, mcpToolName } from "./mcp.ts";
export type { AgentRuntime, ToolSpec } from "./runtime.ts";

/** The agent layer. Synchronous: nothing happens until `start()`. */
export function createAgent(core: CoreServices, opts?: AgentOptions): AgentService {
  return new SpencerAgent(core, opts);
}
