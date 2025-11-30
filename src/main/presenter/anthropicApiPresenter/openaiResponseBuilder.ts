/**
 * OpenAI Response Builder
 * Builds OpenAI Chat Completions format responses
 */

import * as crypto from 'crypto'
import { OpenAIChatCompletionsResponse, OpenAIStreamChunk, OpenAIToolCall } from './types'

/**
 * Build non-streaming OpenAI response
 */
export function buildOpenAIResponse(
  model: string,
  content: string | null,
  toolCalls: OpenAIToolCall[] | undefined,
  finishReason: 'stop' | 'length' | 'tool_calls' | null,
  promptTokens: number,
  completionTokens: number
): OpenAIChatCompletionsResponse {
  return {
    id: `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content,
          tool_calls: toolCalls
        },
        finish_reason: finishReason
      }
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens
    }
  }
}

/**
 * Format OpenAI streaming chunk as SSE
 */
export function formatOpenAISSE(chunk: OpenAIStreamChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

/**
 * Build streaming done event
 */
export function formatOpenAISSEDone(): string {
  return 'data: [DONE]\n\n'
}

/**
 * Map internal stop reason to OpenAI finish reason
 */
export function mapToOpenAIFinishReason(
  reason: string | undefined,
  hasToolCalls: boolean
): 'stop' | 'length' | 'tool_calls' | null {
  if (hasToolCalls) {
    return 'tool_calls'
  }

  if (!reason) return null

  switch (reason) {
    case 'complete':
    case 'stop':
    case 'end_turn':
      return 'stop'
    case 'max_tokens':
    case 'length':
      return 'length'
    case 'tool_use':
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls'
    default:
      return 'stop'
  }
}

/**
 * OpenAI Streaming Response Builder
 */
export class OpenAIStreamingBuilder {
  private id: string
  private model: string
  private created: number
  private toolCallIndex = 0
  private currentToolCalls: Map<
    string,
    {
      index: number
      name: string
      argsBuffer: string
    }
  > = new Map()
  private usage = { promptTokens: 0, completionTokens: 0 }

  constructor(model: string) {
    this.id = `chatcmpl-${crypto.randomUUID().replace(/-/g, '')}`
    this.model = model
    this.created = Math.floor(Date.now() / 1000)
  }

  /**
   * Build initial chunk with role
   */
  buildInitialChunk(): string {
    const chunk: OpenAIStreamChunk = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            content: ''
          },
          finish_reason: null
        }
      ]
    }
    return formatOpenAISSE(chunk)
  }

  /**
   * Build content delta chunk
   */
  buildContentChunk(content: string): string {
    const chunk: OpenAIStreamChunk = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta: {
            content
          },
          finish_reason: null
        }
      ]
    }
    return formatOpenAISSE(chunk)
  }

  /**
   * Build tool call start chunk
   */
  buildToolCallStartChunk(toolId: string, toolName: string): string {
    const index = this.toolCallIndex++

    this.currentToolCalls.set(toolId, {
      index,
      name: toolName,
      argsBuffer: ''
    })

    const chunk: OpenAIStreamChunk = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: toolId,
                type: 'function',
                function: {
                  name: toolName,
                  arguments: ''
                }
              }
            ]
          },
          finish_reason: null
        }
      ]
    }
    return formatOpenAISSE(chunk)
  }

  /**
   * Build tool call arguments chunk
   */
  buildToolCallArgsChunk(toolId: string, args: string): string {
    const toolCall = this.currentToolCalls.get(toolId)
    if (!toolCall) return ''

    const chunk: OpenAIStreamChunk = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: toolCall.index,
                function: {
                  arguments: args
                }
              }
            ]
          },
          finish_reason: null
        }
      ]
    }
    return formatOpenAISSE(chunk)
  }

  /**
   * Set usage information
   */
  setUsage(promptTokens: number, completionTokens: number): void {
    this.usage = { promptTokens, completionTokens }
  }

  /**
   * Build final chunk with finish reason
   */
  buildFinalChunk(finishReason: 'stop' | 'length' | 'tool_calls' | null): string {
    const chunk: OpenAIStreamChunk = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: finishReason
        }
      ],
      usage: {
        prompt_tokens: this.usage.promptTokens,
        completion_tokens: this.usage.completionTokens,
        total_tokens: this.usage.promptTokens + this.usage.completionTokens
      }
    }
    return formatOpenAISSE(chunk)
  }

  /**
   * Build done event
   */
  buildDone(): string {
    return formatOpenAISSEDone()
  }

  /**
   * Check if there are tool calls
   */
  hasToolCalls(): boolean {
    return this.currentToolCalls.size > 0
  }
}
