/**
 * OpenAI Message Converter
 * Converts between OpenAI Chat Completions format and internal ChatMessage format
 */

import { ChatMessage } from '@shared/presenter'
import {
  OpenAIChatCompletionsRequest,
  OpenAIMessage,
  OpenAITool,
  OpenAITextContent,
  OpenAIImageContent
} from './types'

/**
 * Convert OpenAI Chat Completions request to internal ChatMessage format
 */
export function convertOpenAIToInternal(request: OpenAIChatCompletionsRequest): {
  messages: ChatMessage[]
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[]
} {
  const messages: ChatMessage[] = []

  for (const msg of request.messages) {
    const converted = convertOpenAIMessage(msg)
    if (converted) {
      messages.push(converted)
    }
  }

  // Convert tools
  const tools = (request.tools || []).map((tool: OpenAITool) => ({
    name: tool.function.name,
    description: tool.function.description || '',
    inputSchema: tool.function.parameters || {}
  }))

  return { messages, tools }
}

/**
 * Convert a single OpenAI message to internal format
 */
function convertOpenAIMessage(msg: OpenAIMessage): ChatMessage | null {
  switch (msg.role) {
    case 'system':
      return {
        role: 'system',
        content: extractTextContent(msg.content)
      }

    case 'user':
      return convertUserMessage(msg)

    case 'assistant':
      return convertAssistantMessage(msg)

    case 'tool':
      return {
        role: 'tool',
        content: extractTextContent(msg.content),
        tool_call_id: msg.tool_call_id
      }

    default:
      return null
  }
}

/**
 * Convert user message
 */
function convertUserMessage(msg: OpenAIMessage): ChatMessage {
  if (typeof msg.content === 'string') {
    return { role: 'user', content: msg.content }
  }

  if (Array.isArray(msg.content)) {
    const contentParts: Array<
      { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
    > = []

    for (const part of msg.content) {
      if (part.type === 'text') {
        contentParts.push({ type: 'text', text: (part as OpenAITextContent).text })
      } else if (part.type === 'image_url') {
        const imagePart = part as OpenAIImageContent
        contentParts.push({
          type: 'image_url',
          image_url: { url: imagePart.image_url.url }
        })
      }
    }

    // If only one text block, simplify
    if (contentParts.length === 1 && contentParts[0].type === 'text') {
      return { role: 'user', content: contentParts[0].text }
    }

    return { role: 'user', content: contentParts }
  }

  return { role: 'user', content: '' }
}

/**
 * Convert assistant message
 */
function convertAssistantMessage(msg: OpenAIMessage): ChatMessage {
  const message: ChatMessage = {
    role: 'assistant',
    content: extractTextContent(msg.content)
  }

  if (msg.tool_calls && msg.tool_calls.length > 0) {
    message.tool_calls = msg.tool_calls.map((tc) => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments
      }
    }))
  }

  return message
}

/**
 * Extract text content from OpenAI message content
 */
function extractTextContent(content: OpenAIMessage['content']): string {
  if (content === null || content === undefined) {
    return ''
  }

  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .filter((part): part is OpenAITextContent => part.type === 'text')
      .map((part) => part.text)
      .join('')
  }

  return ''
}
