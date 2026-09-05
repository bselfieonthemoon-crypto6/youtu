import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
} from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { ChatOpenAI } from "@langchain/openai";

/**
 * Normalizes non-standard OpenAI-compatible streaming roles.
 *
 * Some Gemini gateways emit `role: "model"` instead of `role: "assistant"`.
 * ChatOpenAI represents those deltas as ChatMessageChunk, which LangChain's
 * agent middleware rejects. Convert them to the equivalent AIMessageChunk.
 */
export class OpenAICompatibleChatModel extends ChatOpenAI {
  private completionsConvertersPatched = false;

  private patchCompletionsConverters(): void {
    if (this.completionsConvertersPatched) return;
    const completions = (
      this as unknown as {
        completions: {
          _convertCompletionsDeltaToBaseMessageChunk: (
            delta: Record<string, any>,
            rawResponse: unknown,
            defaultRole?: string,
          ) => unknown;
          _convertCompletionsMessageToBaseMessage: (
            message: Record<string, any>,
            rawResponse: unknown,
          ) => unknown;
        };
      }
    ).completions;

    const convertDelta =
      completions._convertCompletionsDeltaToBaseMessageChunk.bind(completions);
    completions._convertCompletionsDeltaToBaseMessageChunk = (
      delta,
      rawResponse,
      defaultRole,
    ) =>
      convertDelta(
        normalizeCompletionsAssistantRole(delta, defaultRole),
        rawResponse,
        defaultRole,
      );

    const convertMessage =
      completions._convertCompletionsMessageToBaseMessage.bind(completions);
    completions._convertCompletionsMessageToBaseMessage = (
      message,
      rawResponse,
    ) =>
      convertMessage(normalizeCompletionsAssistantRole(message), rawResponse);
    this.completionsConvertersPatched = true;
  }

  override withConfig(
    config: Parameters<ChatOpenAI["withConfig"]>[0],
  ): ReturnType<ChatOpenAI["withConfig"]> {
    const model = new OpenAICompatibleChatModel(this.fields);
    model.defaultOptions = {
      ...this.defaultOptions,
      ...config,
    };
    return model;
  }

  override bindTools(
    ...args: Parameters<ChatOpenAI["bindTools"]>
  ): ReturnType<ChatOpenAI["bindTools"]> {
    const bound = super.bindTools(...args);
    const invoke = bound.invoke.bind(bound);
    bound.invoke = async (...invokeArgs) =>
      normalizeAssistantMessage(await invoke(...invokeArgs));
    return bound;
  }

  override async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    this.patchCompletionsConverters();
    const result = await super._generate(messages, options, runManager);
    return {
      ...result,
      generations: result.generations.map((generation) =>
        AIMessage.isInstance(generation.message)
          ? generation
          : {
              ...generation,
              message: toAIMessage(generation.message),
            },
      ),
    };
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    this.patchCompletionsConverters();
    for await (const chunk of super._streamResponseChunks(
      messages,
      options,
      runManager,
    )) {
      if (AIMessageChunk.isInstance(chunk.message)) {
        yield chunk;
        continue;
      }

      yield new ChatGenerationChunk({
        text: chunk.text,
        ...(chunk.generationInfo
          ? { generationInfo: chunk.generationInfo }
          : {}),
        message: toAIMessageChunk(chunk.message),
      });
    }
  }
}

export function normalizeCompletionsAssistantRole(
  message: Record<string, any>,
  defaultRole?: string,
): Record<string, any> {
  const role = typeof message.role === "string" ? message.role : defaultRole;
  return role === undefined || role === "model"
    ? { ...message, role: "assistant" }
    : message;
}

function normalizeAssistantMessage<T extends BaseMessage>(message: T): T {
  if (AIMessage.isInstance(message)) return message;
  return toAIMessage(message) as T;
}

type MessageWithAssistantFields = BaseMessage & {
  tool_calls?: ConstructorParameters<typeof AIMessage>[0] extends infer _T
    ? unknown[]
    : never;
  invalid_tool_calls?: unknown[];
  usage_metadata?: unknown;
  tool_call_chunks?: unknown[];
};

/**
 * Build a fresh serializable message instead of passing a ChatMessage instance
 * into another message constructor. Passing the instance copies LangChain's
 * internal `lc_*` fields and makes AIMessage serialize as `not_implemented`.
 */
export function toAIMessage(message: BaseMessage): AIMessage {
  const source = message as MessageWithAssistantFields;
  return new AIMessage({
    content: message.content,
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
    ...(message.id ? { id: message.id } : {}),
    ...(message.name ? { name: message.name } : {}),
    ...(source.tool_calls ? { tool_calls: source.tool_calls } : {}),
    ...(source.invalid_tool_calls
      ? { invalid_tool_calls: source.invalid_tool_calls }
      : {}),
    ...(source.usage_metadata ? { usage_metadata: source.usage_metadata } : {}),
  } as ConstructorParameters<typeof AIMessage>[0]);
}

export function toAIMessageChunk(message: BaseMessage): AIMessageChunk {
  const source = message as MessageWithAssistantFields;
  return new AIMessageChunk({
    content: message.content,
    additional_kwargs: message.additional_kwargs,
    response_metadata: message.response_metadata,
    ...(message.id ? { id: message.id } : {}),
    ...(message.name ? { name: message.name } : {}),
    ...(source.tool_calls ? { tool_calls: source.tool_calls } : {}),
    ...(source.invalid_tool_calls
      ? { invalid_tool_calls: source.invalid_tool_calls }
      : {}),
    ...(source.usage_metadata ? { usage_metadata: source.usage_metadata } : {}),
    ...(source.tool_call_chunks
      ? { tool_call_chunks: source.tool_call_chunks }
      : {}),
  } as ConstructorParameters<typeof AIMessageChunk>[0]);
}
