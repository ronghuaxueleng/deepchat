/**
 * Anthropic Messages API Types
 * Used for Claude Code Router integration
 */

// Content block types
export interface TextContentBlock {
  type: 'text'
  text: string
}

export interface ImageContentBlock {
  type: 'image'
  source: {
    type: 'base64'
    media_type: string
    data: string
  }
}

export interface ToolUseContentBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultContentBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | ContentBlock[]
  is_error?: boolean
}

export type ContentBlock =
  | TextContentBlock
  | ImageContentBlock
  | ToolUseContentBlock
  | ToolResultContentBlock

// Message types
export interface ClaudeMessage {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

// Tool definition
export interface ClaudeTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

// Request types
export interface ClaudeMessagesRequest {
  model: string
  messages: ClaudeMessage[]
  max_tokens: number
  system?: string | TextContentBlock[]
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
  stream?: boolean
  tools?: ClaudeTool[]
  tool_choice?: {
    type: 'auto' | 'any' | 'tool'
    name?: string
  }
  metadata?: {
    user_id?: string
  }
}

export interface ClaudeTokenCountRequest {
  model: string
  messages: ClaudeMessage[]
  system?: string | TextContentBlock[]
  tools?: ClaudeTool[]
}

// Response types
export interface ClaudeUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export interface ClaudeMessagesResponse {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: ContentBlock[]
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null
  stop_sequence: string | null
  usage: ClaudeUsage
}

// Streaming event types
export interface MessageStartEvent {
  type: 'message_start'
  message: {
    id: string
    type: 'message'
    role: 'assistant'
    model: string
    content: ContentBlock[]
    stop_reason: string | null
    stop_sequence: string | null
    usage: ClaudeUsage
  }
}

export interface ContentBlockStartEvent {
  type: 'content_block_start'
  index: number
  content_block: ContentBlock
}

export interface ContentBlockDeltaEvent {
  type: 'content_block_delta'
  index: number
  delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string }
}

export interface ContentBlockStopEvent {
  type: 'content_block_stop'
  index: number
}

export interface MessageDeltaEvent {
  type: 'message_delta'
  delta: {
    stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null
    stop_sequence: string | null
  }
  usage: ClaudeUsage
}

export interface MessageStopEvent {
  type: 'message_stop'
}

export interface PingEvent {
  type: 'ping'
}

export interface ErrorEvent {
  type: 'error'
  error: {
    type: string
    message: string
  }
}

export type StreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent
  | PingEvent
  | ErrorEvent

// API Server configuration
export interface AnthropicApiServerConfig {
  port: number
  host: string
  apiKey?: string // Optional API key for authentication
  defaultProviderId?: string
  defaultModelId?: string
}

// ============================================
// OpenAI Chat Completions API Types
// ============================================

// OpenAI message content types
export interface OpenAITextContent {
  type: 'text'
  text: string
}

export interface OpenAIImageContent {
  type: 'image_url'
  image_url: {
    url: string
    detail?: 'auto' | 'low' | 'high'
  }
}

export type OpenAIMessageContent = string | (OpenAITextContent | OpenAIImageContent)[]

// OpenAI tool call
export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

// OpenAI message types
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: OpenAIMessageContent | null
  name?: string
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

// OpenAI tool definition
export interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

// OpenAI Chat Completions Request
export interface OpenAIChatCompletionsRequest {
  model: string
  messages: OpenAIMessage[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  n?: number
  stream?: boolean
  stop?: string | string[]
  presence_penalty?: number
  frequency_penalty?: number
  logit_bias?: Record<string, number>
  user?: string
  tools?: OpenAITool[]
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } }
  response_format?: { type: 'text' | 'json_object' }
}

// OpenAI Chat Completions Response
export interface OpenAIChatCompletionsResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: 'assistant'
      content: string | null
      tool_calls?: OpenAIToolCall[]
    }
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
  }>
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

// OpenAI Streaming Chunk
export interface OpenAIStreamChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: 'assistant'
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: 'function'
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}
