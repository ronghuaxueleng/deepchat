/**
 * Response Converter
 * Converts internal LLM events to Claude/Anthropic response format
 */

import * as crypto from 'crypto'
import { ClaudeMessagesResponse, ContentBlock, ClaudeUsage, StreamEvent } from './types'

/**
 * Build initial message start event for streaming
 */
export function buildMessageStartEvent(messageId: string, model: string): StreamEvent {
  return {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0
      }
    }
  }
}

/**
 * Build content block start event for text
 */
export function buildTextBlockStartEvent(index: number): StreamEvent {
  return {
    type: 'content_block_start',
    index,
    content_block: {
      type: 'text',
      text: ''
    }
  }
}

/**
 * Build content block start event for tool use
 */
export function buildToolUseBlockStartEvent(
  index: number,
  toolId: string,
  toolName: string
): StreamEvent {
  return {
    type: 'content_block_start',
    index,
    content_block: {
      type: 'tool_use',
      id: toolId,
      name: toolName,
      input: {}
    }
  }
}

/**
 * Build text delta event
 */
export function buildTextDeltaEvent(index: number, text: string): StreamEvent {
  return {
    type: 'content_block_delta',
    index,
    delta: {
      type: 'text_delta',
      text
    }
  }
}

/**
 * Build input JSON delta event for tool use
 */
export function buildInputJsonDeltaEvent(index: number, partialJson: string): StreamEvent {
  return {
    type: 'content_block_delta',
    index,
    delta: {
      type: 'input_json_delta',
      partial_json: partialJson
    }
  }
}

/**
 * Build content block stop event
 */
export function buildContentBlockStopEvent(index: number): StreamEvent {
  return {
    type: 'content_block_stop',
    index
  }
}

/**
 * Build message delta event
 */
export function buildMessageDeltaEvent(
  stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null,
  usage: ClaudeUsage
): StreamEvent {
  return {
    type: 'message_delta',
    delta: {
      stop_reason: stopReason,
      stop_sequence: null
    },
    usage
  }
}

/**
 * Build message stop event
 */
export function buildMessageStopEvent(): StreamEvent {
  return {
    type: 'message_stop'
  }
}

/**
 * Build ping event
 */
export function buildPingEvent(): StreamEvent {
  return {
    type: 'ping'
  }
}

/**
 * Build error event
 */
export function buildErrorEvent(errorType: string, message: string): StreamEvent {
  return {
    type: 'error',
    error: {
      type: errorType,
      message
    }
  }
}

/**
 * Format SSE event
 */
export function formatSSE(event: StreamEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

/**
 * Map internal stop reason to Claude stop reason
 */
export function mapStopReason(
  reason: string | undefined
): 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null {
  if (!reason) return null

  switch (reason) {
    case 'complete':
    case 'stop':
    case 'end_turn':
      return 'end_turn'
    case 'max_tokens':
    case 'length':
      return 'max_tokens'
    case 'tool_use':
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'stop_sequence':
      return 'stop_sequence'
    default:
      return 'end_turn'
  }
}

/**
 * Build non-streaming response
 */
export function buildNonStreamingResponse(
  model: string,
  content: ContentBlock[],
  stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null,
  usage: ClaudeUsage
): ClaudeMessagesResponse {
  return {
    id: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage
  }
}

/**
 * Streaming state manager for building Claude SSE responses
 */
export class StreamingResponseBuilder {
  private messageId: string
  private model: string
  private textBlockIndex = 0
  private toolBlockCounter = 0
  private currentToolCalls: Map<
    string,
    {
      index: number
      name: string
      argsBuffer: string
      started: boolean
    }
  > = new Map()
  private usage: ClaudeUsage = { input_tokens: 0, output_tokens: 0 }
  private stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null = null

  constructor(model: string) {
    this.messageId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
    this.model = model
  }

  /**
   * Get initial SSE events (message start, first content block start, ping)
   */
  getInitialEvents(): string {
    let output = ''
    output += formatSSE(buildMessageStartEvent(this.messageId, this.model))
    output += formatSSE(buildTextBlockStartEvent(this.textBlockIndex))
    output += formatSSE(buildPingEvent())
    return output
  }

  /**
   * Handle text delta
   */
  handleTextDelta(text: string): string {
    return formatSSE(buildTextDeltaEvent(this.textBlockIndex, text))
  }

  /**
   * Handle tool call start
   */
  handleToolCallStart(toolId: string, toolName: string): string {
    this.toolBlockCounter++
    const index = this.textBlockIndex + this.toolBlockCounter

    this.currentToolCalls.set(toolId, {
      index,
      name: toolName,
      argsBuffer: '',
      started: true
    })

    return formatSSE(buildToolUseBlockStartEvent(index, toolId, toolName))
  }

  /**
   * Handle tool call arguments chunk
   */
  handleToolCallChunk(toolId: string, chunk: string): string {
    const toolCall = this.currentToolCalls.get(toolId)
    if (!toolCall) return ''

    toolCall.argsBuffer += chunk

    // Try to parse as complete JSON
    try {
      JSON.parse(toolCall.argsBuffer)
      // If parsing succeeds, send the complete JSON
      return formatSSE(buildInputJsonDeltaEvent(toolCall.index, toolCall.argsBuffer))
    } catch {
      // JSON is incomplete, don't send yet
      return ''
    }
  }

  /**
   * Handle tool call end
   */
  handleToolCallEnd(toolId: string, args: string): string {
    const toolCall = this.currentToolCalls.get(toolId)
    if (!toolCall) return ''

    // Send final JSON if not already sent
    let output = ''
    if (toolCall.argsBuffer !== args) {
      output += formatSSE(buildInputJsonDeltaEvent(toolCall.index, args))
    }

    return output
  }

  /**
   * Set usage information
   */
  setUsage(inputTokens: number, outputTokens: number): void {
    this.usage = {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    }
  }

  /**
   * Set stop reason
   */
  setStopReason(reason: string): void {
    this.stopReason = mapStopReason(reason)
  }

  /**
   * Get final SSE events
   */
  getFinalEvents(): string {
    let output = ''

    // Close text block
    output += formatSSE(buildContentBlockStopEvent(this.textBlockIndex))

    // Close all tool blocks
    for (const [, toolCall] of this.currentToolCalls) {
      output += formatSSE(buildContentBlockStopEvent(toolCall.index))
    }

    // Message delta with final stop reason and usage
    output += formatSSE(
      buildMessageDeltaEvent(
        this.currentToolCalls.size > 0 ? 'tool_use' : this.stopReason || 'end_turn',
        this.usage
      )
    )

    // Message stop
    output += formatSSE(buildMessageStopEvent())

    return output
  }

  /**
   * Get error event
   */
  getErrorEvent(errorType: string, message: string): string {
    return formatSSE(buildErrorEvent(errorType, message))
  }
}
