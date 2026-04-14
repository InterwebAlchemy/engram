import type {
  ChatMessage,
  Message,
} from '@interwebalchemy/engram-core';
import { MemoryState } from '@interwebalchemy/engram-core';
import { MarkdownRenderer, type App } from 'obsidian';
import type EngramPlugin from '../main';
import type {
  CompletionConfig,
  ProviderAdapter,
} from '../providers/types';
import { Ciph3rTextAnimator } from '../utils/ciph3r';
import {
  getErrorMessage,
  parseThinkContent,
  THINKING_LABEL,
} from './chat-view-helpers';

const STREAMING_REASONING_CLASS = 'engram-reasoning-streaming';

interface StreamState {
  accumulated: string;
  accumulatedReasoning: string;
  contentStarted: boolean;
}

interface StreamElements {
  readonly animator: Ciph3rTextAnimator;
  readonly messagesContainer: HTMLElement;
  readonly streamingContent: HTMLDivElement;
  readonly thinkingBody: HTMLDivElement;
  readonly thinkingDetails: HTMLDetailsElement;
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

export async function streamAssistantReply(
  options: StreamAssistantReplyOptions,
): Promise<StreamAssistantReplyResult> {
  const {
    app,
    chatMessages,
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
  };

  try {
    for await (const chunk of provider.stream(chatMessages, completionConfig, signal)) {
      if (chunk.done) {
        break;
      }

      updateReasoningChunk({
        app,
        plugin,
        reasoning: chunk.reasoning,
        elements,
        state,
      });
      updateContentChunk({
        app,
        plugin,
        content: chunk.content,
        elements,
        state,
      });
    }

    return finalizeAssistantMessage({
      app,
      plugin,
      provider,
      selectedModel,
      elements,
      state,
    });
  } catch (error) {
    return error instanceof Error && error.name === 'AbortError'
      ? { status: 'aborted' }
      : { status: 'error', error: getErrorMessage(error) };
  } finally {
    const {
      animator,
      thinkingDetails,
    } = elements;
    animator.stop();
    thinkingDetails.classList.remove(STREAMING_REASONING_CLASS);
  }
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

  const streamingContent = streamingBubble.createDiv({ cls: 'engram-message-content' });
  return {
    animator,
    messagesContainer,
    streamingContent,
    thinkingBody,
    thinkingDetails,
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
  if (state.contentStarted) {
    // Nothing to do.
  } else {
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

function finalizeAssistantMessage(options: {
  readonly app: App;
  readonly plugin: EngramPlugin;
  readonly provider: ProviderAdapter;
  readonly selectedModel: string;
  readonly elements: StreamElements;
  readonly state: StreamState;
}): StreamAssistantReplyResult {
  const {
    app,
    plugin,
    provider,
    selectedModel,
    elements,
    state,
  } = options;
  const finalizedResponse = finalizeResponse(state.accumulated, state.accumulatedReasoning);
  const {
    content,
    reasoning,
  } = finalizedResponse;
  const {
    thinkingBody,
    thinkingDetails,
  } = elements;

  if (reasoning.length === 0) {
    thinkingDetails.remove();
  } else {
    thinkingBody.empty();
    void MarkdownRenderer.render(app, reasoning, thinkingBody, '', plugin);
  }

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
