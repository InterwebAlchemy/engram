import type { MemoryManager } from '../memory.js';
import {
  type ToolArgs,
  type ToolResponse,
  formatUnknown,
  textResult,
  toolArgs,
} from './args.js';
import {
  handleContextTool,
  handleConversationTool,
  handleMemoryTool,
  handleNoteTool,
  handleScratchTool,
  handleSkillTool,
  handleSoulTool,
} from './memory-handlers.js';
import {
  handleInboxTool,
  handleThreadTool,
} from './thread-handlers.js';

type ToolHandler = (manager: MemoryManager, args: ToolArgs) => Promise<ToolResponse>;

const TOOL_HANDLERS = {
  memory: handleMemoryTool,
  soul: handleSoulTool,
  context: handleContextTool,
  note: handleNoteTool,
  conversation: handleConversationTool,
  skill: handleSkillTool,
  scratch: handleScratchTool,
  thread: handleThreadTool,
  inbox: handleInboxTool,
} as const satisfies Record<string, ToolHandler>;

export type ToolName = keyof typeof TOOL_HANDLERS;

export function getToolHandler(name: string): ToolHandler | undefined {
  const handlers: Record<string, ToolHandler> = TOOL_HANDLERS;
  return Object.hasOwn(handlers, name) ? handlers[name] : undefined;
}

/**
 * Dispatch a tool call by name. Catches handler errors and turns them into
 * error responses so callers (MCP server, in-process plugin) share one contract.
 */
export async function executeToolCall(options: {
  readonly manager: MemoryManager;
  readonly name: string;
  readonly args: unknown;
}): Promise<ToolResponse> {
  const { manager, name, args } = options;
  const handler = getToolHandler(name);
  if (handler === undefined) {
    return textResult(`Unknown tool: ${name}`, true);
  }

  try {
    return await handler(manager, toolArgs(args));
  } catch (error) {
    return textResult(`Error: ${formatUnknown(error)}`, true);
  }
}

/**
 * Convenience for callers that want plain text instead of the MCP content shape.
 */
export function extractText(response: ToolResponse): { text: string; isError: boolean } {
  const { content, isError = false } = response;
  const [firstBlock] = content;
  return {
    text: firstBlock.text,
    isError,
  };
}
