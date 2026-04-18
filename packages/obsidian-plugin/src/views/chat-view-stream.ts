import {
  executeToolCall,
  extractText,
  MemoryState,
  type ChatMessage,
  type Message,
} from '@interwebalchemy/engram-core';
import { MarkdownRenderer, type App } from 'obsidian';
import type EngramPlugin from '../main';
import type {
  CompletionConfig,
  ExtendedChatMessage,
  ProviderAdapter,
  StopReason,
  ToolResultBlock,
  ToolUseEvent,
} from '../providers/types';
import { Ciph3rTextAnimator } from '../utils/ciph3r';
import {
  getErrorMessage,
  parseThinkContent,
  THINKING_LABEL,
} from './chat-view-helpers';

const STREAMING_REASONING_CLASS = 'engram-reasoning-streaming';
const MAX_TOOL_ROUNDS = 5;
const JSON_INDENT = 2;

interface StreamState {
  accumulated: string;
  accumulatedReasoning: string;
  contentStarted: boolean;
  toolUses: ToolUseEvent[];
  stopReason: StopReason | undefined;
}

interface StreamElements {
  readonly animator: Ciph3rTextAnimator;
  readonly messagesContainer: HTMLElement;
  readonly streamingContent: HTMLDivElement;
  readonly toolsContainer: HTMLDivElement;
  readonly thinkingBody: HTMLDivElement;
  readonly thinkingDetails: HTMLDetailsElement;
  readonly bubble: HTMLDivElement;
}

interface StreamAssistantReplyOptions {
  readonly app: App;
  readonly chatMessages: ChatMessage[];
  readonly completionConfig: CompletionConfig;
  readonly messagesContainer: HTMLElement;
  readonly plugin: EngramPlugin;
  readonly provider: ProviderAdapter;
  readonly selectedModel: string;
  readonly signal: AbortSignal;
}

export type StreamAssistantReplyResult =
  | { readonly status: 'aborted' }
  | { readonly status: 'error'; readonly error: string }
  | { readonly status: 'ok'; readonly message: Message };

/**
 * Stream the assistant response, executing any requested tool calls in a loop.
 *
 * Each iteration streams one model response. If it terminates with
 * `stopReason === 'tool_use'` and tool calls were collected, we execute them
 * via the shared core registry, append the assistant/tool messages to a local
 * history, and stream again. Stops on `end_turn`, any other terminal reason,
 * or after MAX_TOOL_ROUNDS iterations to keep runaway loops bounded.
 */
export async function streamAssistantReply(
  options: StreamAssistantReplyOptions,
): Promise<StreamAssistantReplyResult> {
  const { chatMessages } = options;
  const history: ExtendedChatMessage[] = chatMessages.map((msg) => ({ ...msg }));

  /* eslint-disable no-await-in-loop -- tool rounds are fundamentally sequential. */
  for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
    const roundResult = await runStreamRound(options, history);
    if (roundResult.status !== 'continue') {
      return roundResult.result;
    }
  }
  /* eslint-enable no-await-in-loop */

  return {
    status: 'error',
    error: `Tool loop exceeded ${String(MAX_TOOL_ROUNDS)} rounds without a terminal response.`,
  };
}

type RoundOutcome =
  | { readonly status: 'terminal'; readonly result: StreamAssistantReplyResult }
  | { readonly status: 'continue'; readonly result: null };

async function runStreamRound(
  options: StreamAssistantReplyOptions,
  history: ExtendedChatMessage[],
): Promise<RoundOutcome | { readonly status: 'terminal'; readonly result: StreamAssistantReplyResult }> {
  const {
    app,
    completionConfig,
    messagesContainer,
    plugin,
    provider,
    selectedModel,
    signal,
  } = options;

  const elements = createStreamingElements(messagesContainer, selectedModel);
  const state: StreamState = {
    accumulated: '',
    accumulatedReasoning: '',
    contentStarted: false,
    toolUses: [],
    stopReason: undefined,
  };

  try {
    await consumeStream({ app, plugin, provider, history, completionConfig, signal, elements, state });
  } catch (error) {
    stopStreamingUi(elements);
    const result: StreamAssistantReplyResult = error instanceof Error && error.name === 'AbortError'
      ? { status: 'aborted' }
      : { status: 'error', error: getErrorMessage(error) };
    return { status: 'terminal', result };
  }

  const parsed = finalizeResponse(state.accumulated, state.accumulatedReasoning);
  const { content, reasoning } = parsed;
  finalizeBubble(app, plugin, elements, parsed);

  if (state.stopReason !== 'tool_use' || state.toolUses.length === 0) {
    return {
      status: 'terminal',
      result: buildAssistantMessage({ provider, selectedModel, content, reasoning }),
    };
  }

  history.push({ role: 'assistant', content, toolUses: state.toolUses });
  const toolResults = await executeToolCalls(plugin, state.toolUses, elements);
  history.push({ role: 'user', content: '', toolResults });
  return { status: 'continue', result: null };
}

async function consumeStream(options: {
  readonly app: App;
  readonly plugin: EngramPlugin;
  readonly provider: ProviderAdapter;
  readonly history: ExtendedChatMessage[];
  readonly completionConfig: CompletionConfig;
  readonly signal: AbortSignal;
  readonly elements: StreamElements;
  readonly state: StreamState;
}): Promise<void> {
  const { app, plugin, provider, history, completionConfig, signal, elements, state } = options;
  for await (const chunk of provider.stream(history, completionConfig, signal)) {
    const { stopReason, toolUse, done, reasoning, content } = chunk;
    if (stopReason !== undefined) {
      state.stopReason = stopReason;
    }
    if (toolUse !== undefined) {
      state.toolUses.push(toolUse);
      renderToolCallCard(elements, toolUse);
    }
    if (done) {
      break;
    }
    updateReasoningChunk({ app, plugin, reasoning, elements, state });
    updateContentChunk({ app, plugin, content, elements, state });
  }
}

async function executeToolCalls(
  plugin: EngramPlugin,
  toolUses: readonly ToolUseEvent[],
  elements: StreamElements,
): Promise<ToolResultBlock[]> {
  return await Promise.all(
    toolUses.map(async (toolUse) => await runOneToolCall(plugin, toolUse, elements)),
  );
}

async function runOneToolCall(
  plugin: EngramPlugin,
  toolUse: ToolUseEvent,
  elements: StreamElements,
): Promise<ToolResultBlock> {
  const response = await executeToolCall({
    manager: plugin.memoryManager,
    name: toolUse.name,
    args: toolUse.input,
  });
  const { text, isError } = extractText(response);
  renderToolResultCard(elements, toolUse, text, isError);
  return { toolUseId: toolUse.id, content: text, isError };
}

function createStreamingElements(
  messagesContainer: HTMLElement,
  selectedModel: string,
): StreamElements {
  const streamingBubble = messagesContainer.createDiv({
    cls: 'engram-message engram-message-assistant engram-message-streaming',
  });
  streamingBubble.createDiv({ cls: 'engram-message-header' }).createSpan({
    cls: 'engram-message-role',
    text: `Assistant [${selectedModel}]`,
  });

  const thinkingDetails = streamingBubble.createEl('details', {
    cls: `engram-reasoning-details ${STREAMING_REASONING_CLASS}`,
    attr: { open: '' },
  });
  const thinkingSummary = thinkingDetails.createEl('summary', {
    cls: 'engram-reasoning-summary',
  });
  const thinkingLabel = thinkingSummary.createSpan({ text: THINKING_LABEL });
  const thinkingBody = thinkingDetails.createDiv({ cls: 'engram-reasoning-content' });
  const animator = new Ciph3rTextAnimator(thinkingLabel, THINKING_LABEL);
  animator.start();

  const toolsContainer = streamingBubble.createDiv({ cls: 'engram-tool-calls' });
  const streamingContent = streamingBubble.createDiv({ cls: 'engram-message-content' });
  return {
    animator,
    messagesContainer,
    streamingContent,
    toolsContainer,
    thinkingBody,
    thinkingDetails,
    bubble: streamingBubble,
  };
}

function updateReasoningChunk(options: {
  readonly app: App;
  readonly plugin: EngramPlugin;
  readonly reasoning: string | undefined;
  readonly elements: StreamElements;
  readonly state: StreamState;
}): void {
  const {
    app,
    plugin,
    reasoning,
    elements,
    state,
  } = options;
  if (reasoning === undefined || reasoning.length === 0) {
    return;
  }

  state.accumulatedReasoning += reasoning;
  const {
    messagesContainer,
    thinkingBody,
  } = elements;
  thinkingBody.empty();
  void MarkdownRenderer.render(app, state.accumulatedReasoning, thinkingBody, '', plugin);
  scrollToBottom(messagesContainer);
}

function updateContentChunk(options: {
  readonly app: App;
  readonly plugin: EngramPlugin;
  readonly content: string | undefined;
  readonly elements: StreamElements;
  readonly state: StreamState;
}): void {
  const {
    app,
    plugin,
    content,
    elements,
    state,
  } = options;
  if (content === undefined || content.length === 0) {
    return;
  }

  state.accumulated += content;
  if (!state.contentStarted) {
    state.contentStarted = true;
    const {
      animator,
      thinkingDetails,
    } = elements;
    animator.stop();
    thinkingDetails.removeAttribute('open');
    thinkingDetails.classList.remove(STREAMING_REASONING_CLASS);
  }

  const {
    messagesContainer,
    streamingContent,
  } = elements;
  streamingContent.empty();
  void MarkdownRenderer.render(app, state.accumulated, streamingContent, '', plugin);
  scrollToBottom(messagesContainer);
}

function renderToolCallCard(
  elements: StreamElements,
  toolUse: ToolUseEvent,
): void {
  const { toolsContainer, messagesContainer } = elements;
  const { id, name, input } = toolUse;
  const card = toolsContainer.createEl('details', {
    cls: 'engram-tool-card engram-tool-card-pending',
  });
  card.dataset.toolUseId = id;
  const summary = card.createEl('summary', { cls: 'engram-tool-card-summary' });
  summary.createSpan({ cls: 'engram-tool-card-name', text: name });
  const action = pickActionLabel(input);
  if (action !== undefined) {
    summary.createSpan({ cls: 'engram-tool-card-action', text: action });
  }
  summary.createSpan({ cls: 'engram-tool-card-status', text: 'pending…' });

  const body = card.createDiv({ cls: 'engram-tool-card-body' });
  body.createEl('pre', {
    cls: 'engram-tool-card-input',
    text: JSON.stringify(input, null, JSON_INDENT),
  });
  scrollToBottom(messagesContainer);
}

function renderToolResultCard(
  elements: StreamElements,
  toolUse: ToolUseEvent,
  resultText: string,
  isError: boolean,
): void {
  const { toolsContainer, messagesContainer } = elements;
  const card = findToolCard(toolsContainer, toolUse.id);
  if (card === null) {
    return;
  }
  card.classList.remove('engram-tool-card-pending');
  card.classList.add(isError ? 'engram-tool-card-error' : 'engram-tool-card-ok');

  const status = card.querySelector<HTMLElement>('.engram-tool-card-status');
  if (status !== null) {
    status.textContent = isError ? 'error' : 'ok';
  }

  const body = card.querySelector<HTMLElement>('.engram-tool-card-body');
  if (body !== null) {
    body.createEl('pre', {
      cls: 'engram-tool-card-result',
      text: resultText,
    });
  }
  scrollToBottom(messagesContainer);
}

function findToolCard(
  container: HTMLElement,
  toolUseId: string,
): HTMLElement | null {
  for (const card of Array.from(container.children)) {
    if (card instanceof HTMLElement && card.dataset.toolUseId === toolUseId) {
      return card;
    }
  }
  return null;
}

function pickActionLabel(input: Record<string, unknown>): string | undefined {
  const { action } = input;
  return typeof action === 'string' ? action : undefined;
}

function finalizeBubble(
  app: App,
  plugin: EngramPlugin,
  elements: StreamElements,
  parsed: { content: string; reasoning: string },
): void {
  stopStreamingUi(elements);

  const { thinkingBody, thinkingDetails, streamingContent, bubble } = elements;
  const { content, reasoning } = parsed;

  if (reasoning.length === 0) {
    thinkingDetails.remove();
  } else {
    thinkingBody.empty();
    void MarkdownRenderer.render(app, reasoning, thinkingBody, '', plugin);
  }

  if (content.length > 0) {
    streamingContent.empty();
    void MarkdownRenderer.render(app, content, streamingContent, '', plugin);
  }

  bubble.classList.remove('engram-message-streaming');
}

function stopStreamingUi(elements: StreamElements): void {
  const { animator, thinkingDetails } = elements;
  animator.stop();
  thinkingDetails.classList.remove(STREAMING_REASONING_CLASS);
}

function buildAssistantMessage(options: {
  readonly provider: ProviderAdapter;
  readonly selectedModel: string;
  readonly content: string;
  readonly reasoning: string;
}): StreamAssistantReplyResult {
  const { provider, selectedModel, content, reasoning } = options;
  return {
    status: 'ok',
    message: {
      role: 'assistant',
      content,
      timestamp: new Date(),
      provider: provider.id,
      model: selectedModel,
      memoryState: MemoryState.Default,
      metadata: reasoning.length === 0 ? undefined : { reasoning },
    },
  };
}

function finalizeResponse(
  accumulated: string,
  accumulatedReasoning: string,
): { content: string; reasoning: string } {
  if (accumulatedReasoning.length > 0) {
    return {
      content: accumulated,
      reasoning: accumulatedReasoning,
    };
  }

  const parsed = parseThinkContent(accumulated);
  return {
    content: parsed.content.length === 0 ? accumulated : parsed.content,
    reasoning: parsed.reasoning,
  };
}

function scrollToBottom(messagesContainer: HTMLElement): void {
  const container = messagesContainer;
  const {
    scrollHeight,
  } = container;
  container.scrollTop = scrollHeight;
}
