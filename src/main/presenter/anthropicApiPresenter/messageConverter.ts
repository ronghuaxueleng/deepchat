/**
 * Message Converter
 * Converts between Claude/Anthropic format and internal ChatMessage format
 */

import { ChatMessage } from '@shared/presenter'
import {
  ClaudeMessage,
  ClaudeMessagesRequest,
  TextContentBlock,
  ToolUseContentBlock,
  ToolResultContentBlock,
  ClaudeTool
} from './types'

/**
 * Convert Claude/Anthropic request to internal ChatMessage format
 */
export function convertClaudeToInternal(request: ClaudeMessagesRequest): {
  messages: ChatMessage[]
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[]
} {
  const messages: ChatMessage[] = []

  // Add system message if present
  if (request.system) {
    let systemText = ''
    if (typeof request.system === 'string') {
      systemText = request.system
    } else if (Array.isArray(request.system)) {
      systemText = request.system
        .filter((block): block is TextContentBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n\n')
    }

    if (systemText.trim()) {
      messages.push({
        role: 'system',
        content: systemText.trim()
      })
    }
  }

  // Process Claude messages
  for (let i = 0; i < request.messages.length; i++) {
    const msg = request.messages[i]

    if (msg.role === 'user') {
      const userMessage = convertUserMessage(msg)
      messages.push(userMessage)

      // Check for tool results in this user message
      if (typeof msg.content !== 'string' && Array.isArray(msg.content)) {
        const toolResults = msg.content.filter(
          (block): block is ToolResultContentBlock => block.type === 'tool_result'
        )

        for (const result of toolResults) {
          messages.push({
            role: 'tool',
            content:
              typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
            tool_call_id: result.tool_use_id
          })
        }
      }
    } else if (msg.role === 'assistant') {
      const assistantMessage = convertAssistantMessage(msg)
      messages.push(assistantMessage)
    }
  }

  // Convert tools
  const tools = (request.tools || []).map((tool: ClaudeTool) => ({
    name: tool.name,
    description: tool.description || '',
    inputSchema: tool.input_schema
  }))

  return { messages, tools }
}

/**
 * Convert user message from Claude format
 */
function convertUserMessage(msg: ClaudeMessage): ChatMessage {
  if (typeof msg.content === 'string') {
    return { role: 'user', content: msg.content }
  }

  // Handle multimodal content
  const contentParts: Array<
    { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
  > = []

  for (const block of msg.content) {
    if (block.type === 'text') {
      contentParts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      // Convert Claude image format to OpenAI format
      const imageBlock = block as {
        type: 'image'
        source: { type: string; media_type: string; data: string }
      }
      if (imageBlock.source?.type === 'base64') {
        contentParts.push({
          type: 'image_url',
          image_url: {
            url: `data:${imageBlock.source.media_type};base64,${imageBlock.source.data}`
          }
        })
      }
    }
    // Skip tool_result blocks as they are handled separately
  }

  // If only one text block, return as string
  if (contentParts.length === 1 && contentParts[0].type === 'text') {
    return { role: 'user', content: contentParts[0].text }
  }

  return { role: 'user', content: contentParts }
}

/**
 * Convert assistant message from Claude format
 */
function convertAssistantMessage(msg: ClaudeMessage): ChatMessage {
  if (typeof msg.content === 'string') {
    return { role: 'assistant', content: msg.content }
  }

  const textParts: string[] = []
  const toolCalls: Array<{
    id: string
    type: 'function'
    function: {
      name: string
      arguments: string
    }
  }> = []

  for (const block of msg.content) {
    if (block.type === 'text') {
      textParts.push(block.text)
    } else if (block.type === 'tool_use') {
      const toolUseBlock = block as ToolUseContentBlock
      toolCalls.push({
        id: toolUseBlock.id,
        type: 'function',
        function: {
          name: toolUseBlock.name,
          arguments: JSON.stringify(toolUseBlock.input)
        }
      })
    }
  }

  const message: ChatMessage = {
    role: 'assistant',
    content: textParts.join('') || null
  }

  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls
  }

  return message
}

/**
 * Map Claude model name to provider and model ID
 * Returns { providerId, modelId } or null if no mapping found
 */
export function mapClaudeModel(
  model: string,
  defaultProviderId?: string,
  defaultModelId?: string
): { providerId: string; modelId: string } | null {
  // If default values are provided, use them
  if (defaultProviderId && defaultModelId) {
    return { providerId: defaultProviderId, modelId: defaultModelId }
  }

  // Try to parse model string in format "providerId/modelId" or "providerId,modelId"
  if (model.includes('/')) {
    const [providerId, modelId] = model.split('/', 2)
    if (providerId && modelId) {
      return { providerId, modelId }
    }
  }

  if (model.includes(',')) {
    const [providerId, modelId] = model.split(',', 2)
    if (providerId && modelId) {
      return { providerId: providerId.trim(), modelId: modelId.trim() }
    }
  }

  // Default mappings for Claude model names
  const claudeModelMappings: Record<string, { providerId: string; modelId: string }> = {
    // Anthropic models - map to configured provider
    'claude-3-5-sonnet-20241022': {
      providerId: 'anthropic',
      modelId: 'claude-3-5-sonnet-20241022'
    },
    'claude-3-5-haiku-20241022': { providerId: 'anthropic', modelId: 'claude-3-5-haiku-20241022' },
    'claude-3-opus-20240229': { providerId: 'anthropic', modelId: 'claude-3-opus-20240229' },
    'claude-3-sonnet-20240229': { providerId: 'anthropic', modelId: 'claude-3-sonnet-20240229' },
    'claude-3-haiku-20240307': { providerId: 'anthropic', modelId: 'claude-3-haiku-20240307' },
    'claude-sonnet-4-20250514': { providerId: 'anthropic', modelId: 'claude-sonnet-4-20250514' },
    'claude-opus-4-20250514': { providerId: 'anthropic', modelId: 'claude-opus-4-20250514' }
  }

  if (claudeModelMappings[model]) {
    return claudeModelMappings[model]
  }

  // If no mapping found and default providerId is available, use the model name directly
  if (defaultProviderId) {
    return { providerId: defaultProviderId, modelId: model }
  }

  return null
}
