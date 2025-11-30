/**
 * Anthropic API Presenter
 *
 * Provides an Anthropic-compatible Messages API endpoint that allows
 * Claude Code Router to connect to DeepChat and use configured LLM providers.
 *
 * Endpoints:
 * - POST /v1/messages - Anthropic Messages API endpoint
 * - POST /v1/messages/count_tokens - Token counting endpoint
 * - POST /v1/chat/completions - OpenAI Chat Completions API endpoint
 * - GET /v1/models - List available models
 * - GET /health - Health check endpoint
 */

import * as http from 'http'
import { URL } from 'url'
import * as crypto from 'crypto'
import { IConfigPresenter, ILlmProviderPresenter, ChatMessage } from '@shared/presenter'
import {
  AnthropicApiServerConfig,
  ClaudeMessagesRequest,
  ContentBlock,
  ClaudeUsage,
  ClaudeTokenCountRequest,
  OpenAIChatCompletionsRequest,
  OpenAIToolCall
} from './types'
import { convertClaudeToInternal, mapClaudeModel } from './messageConverter'
import {
  StreamingResponseBuilder,
  buildNonStreamingResponse,
  mapStopReason
} from './responseConverter'
import { convertOpenAIToInternal } from './openaiConverter'
import {
  OpenAIStreamingBuilder,
  buildOpenAIResponse,
  mapToOpenAIFinishReason
} from './openaiResponseBuilder'

export class AnthropicApiPresenter {
  private server: http.Server | null = null
  private config: AnthropicApiServerConfig
  private llmProviderPresenter: ILlmProviderPresenter
  private isRunning = false

  constructor(
    _configPresenter: IConfigPresenter,
    llmProviderPresenter: ILlmProviderPresenter,
    config?: Partial<AnthropicApiServerConfig>
  ) {
    // configPresenter is reserved for future use (reading API server settings from config)
    this.llmProviderPresenter = llmProviderPresenter
    this.config = {
      port: config?.port || 3456,
      host: config?.host || '0.0.0.0',
      apiKey: config?.apiKey,
      defaultProviderId: config?.defaultProviderId,
      defaultModelId: config?.defaultModelId
    }
  }

  /**
   * Start the HTTP server
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[AnthropicAPI] Server is already running')
      return
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((error) => {
          console.error('[AnthropicAPI] Unhandled error:', error)
          this.sendError(res, 500, 'internal_error', 'An internal error occurred')
        })
      })

      this.server.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          console.error(`[AnthropicAPI] Port ${this.config.port} is already in use`)
          reject(new Error(`Port ${this.config.port} is already in use`))
        } else {
          console.error('[AnthropicAPI] Server error:', error)
          reject(error)
        }
      })

      this.server.listen(this.config.port, this.config.host, () => {
        this.isRunning = true
        console.log(
          `[AnthropicAPI] Server started on http://${this.config.host}:${this.config.port}`
        )
        console.log(`[AnthropicAPI] Messages endpoint: /v1/messages`)
        resolve()
      })
    })
  }

  /**
   * Stop the HTTP server
   */
  async stop(): Promise<void> {
    if (!this.server) {
      return
    }

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.isRunning = false
        this.server = null
        console.log('[AnthropicAPI] Server stopped')
        resolve()
      })
    })
  }

  /**
   * Get server status
   */
  getStatus(): { isRunning: boolean; port: number; host: string } {
    return {
      isRunning: this.isRunning,
      port: this.config.port,
      host: this.config.host
    }
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<AnthropicApiServerConfig>): void {
    Object.assign(this.config, config)
  }

  /**
   * Handle incoming HTTP request
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Api-Key, anthropic-version'
    )

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    const path = url.pathname

    // Validate API key if configured
    if (this.config.apiKey) {
      const authHeader = req.headers['authorization']
      const apiKeyHeader = req.headers['x-api-key']
      const providedKey =
        (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null) ||
        (typeof apiKeyHeader === 'string' ? apiKeyHeader : null)

      if (providedKey !== this.config.apiKey) {
        this.sendError(res, 401, 'authentication_error', 'Invalid API key')
        return
      }
    }

    try {
      if (req.method === 'POST' && path === '/v1/messages') {
        await this.handleMessages(req, res)
      } else if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
        await this.handleCountTokens(req, res)
      } else if (req.method === 'POST' && path === '/v1/chat/completions') {
        await this.handleChatCompletions(req, res)
      } else if (req.method === 'GET' && path === '/v1/models') {
        await this.handleListModels(res)
      } else if (req.method === 'GET' && path === '/health') {
        this.handleHealth(res)
      } else if (req.method === 'GET' && path === '/') {
        this.handleRoot(res)
      } else {
        this.sendError(res, 404, 'not_found', `Endpoint not found: ${path}`)
      }
    } catch (error) {
      console.error('[AnthropicAPI] Request error:', error)
      const message = error instanceof Error ? error.message : 'Unknown error'
      this.sendError(res, 500, 'api_error', message)
    }
  }

  /**
   * Handle POST /v1/messages
   */
  private async handleMessages(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await this.readBody(req)
    let request: ClaudeMessagesRequest

    try {
      request = JSON.parse(body) as ClaudeMessagesRequest
    } catch {
      this.sendError(res, 400, 'invalid_request_error', 'Invalid JSON body')
      return
    }

    // Validate required fields
    if (!request.model) {
      this.sendError(res, 400, 'invalid_request_error', 'Missing required field: model')
      return
    }
    if (!request.messages || !Array.isArray(request.messages)) {
      this.sendError(res, 400, 'invalid_request_error', 'Missing required field: messages')
      return
    }
    if (!request.max_tokens) {
      this.sendError(res, 400, 'invalid_request_error', 'Missing required field: max_tokens')
      return
    }

    // Map model to provider
    const modelMapping = mapClaudeModel(
      request.model,
      this.config.defaultProviderId,
      this.config.defaultModelId
    )

    if (!modelMapping) {
      this.sendError(
        res,
        400,
        'invalid_request_error',
        `Unable to map model: ${request.model}. Use format "providerId/modelId" or configure default provider.`
      )
      return
    }

    const { providerId, modelId } = modelMapping

    // Verify provider exists
    try {
      this.llmProviderPresenter.getProviderById(providerId)
    } catch {
      this.sendError(res, 400, 'invalid_request_error', `Provider not found: ${providerId}`)
      return
    }

    // Convert request
    const { messages } = convertClaudeToInternal(request)

    if (request.stream) {
      await this.handleStreamingResponse(res, request, providerId, modelId, messages)
    } else {
      await this.handleNonStreamingResponse(res, request, providerId, modelId, messages)
    }
  }

  /**
   * Handle streaming response
   */
  private async handleStreamingResponse(
    res: http.ServerResponse,
    request: ClaudeMessagesRequest,
    providerId: string,
    modelId: string,
    messages: ReturnType<typeof convertClaudeToInternal>['messages']
  ): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    })

    const builder = new StreamingResponseBuilder(request.model)
    const eventId = crypto.randomUUID()

    try {
      // Send initial events
      res.write(builder.getInitialEvents())

      // Start stream completion
      const stream = this.llmProviderPresenter.startStreamCompletion(
        providerId,
        messages,
        modelId,
        eventId,
        request.temperature ?? 0.6,
        request.max_tokens
      )

      let inputTokens = 0
      let outputTokens = 0

      for await (const event of stream) {
        if (res.destroyed) {
          break
        }

        // Handle LLMAgentEvent format from agentLoopHandler
        switch (event.type) {
          case 'response': {
            const data = event.data
            // Handle text content
            if (data.content) {
              res.write(builder.handleTextDelta(data.content))
            }
            // Handle reasoning content (treat as text for Claude Code)
            if (data.reasoning_content) {
              res.write(builder.handleTextDelta(data.reasoning_content))
            }
            // Handle tool calls
            if (data.tool_call === 'start' && data.tool_call_id && data.tool_call_name) {
              res.write(builder.handleToolCallStart(data.tool_call_id, data.tool_call_name))
            }
            if (data.tool_call === 'update' && data.tool_call_id && data.tool_call_params) {
              const chunkOutput = builder.handleToolCallChunk(
                data.tool_call_id,
                data.tool_call_params
              )
              if (chunkOutput) {
                res.write(chunkOutput)
              }
            }
            // Handle usage
            if (data.totalUsage) {
              inputTokens = data.totalUsage.prompt_tokens || 0
              outputTokens = data.totalUsage.completion_tokens || 0
            }
            break
          }

          case 'end': {
            builder.setStopReason(event.data.userStop ? 'stop_sequence' : 'end_turn')
            break
          }

          case 'error': {
            res.write(builder.getErrorEvent('api_error', event.data.error))
            break
          }
        }
      }

      // Set final usage
      builder.setUsage(inputTokens, outputTokens)

      // Send final events
      res.write(builder.getFinalEvents())
      res.end()
    } catch (error) {
      console.error('[AnthropicAPI] Streaming error:', error)
      const message = error instanceof Error ? error.message : 'Unknown error'
      res.write(builder.getErrorEvent('api_error', message))
      res.end()
    }
  }

  /**
   * Handle non-streaming response
   */
  private async handleNonStreamingResponse(
    res: http.ServerResponse,
    request: ClaudeMessagesRequest,
    providerId: string,
    modelId: string,
    messages: ReturnType<typeof convertClaudeToInternal>['messages']
  ): Promise<void> {
    const eventId = crypto.randomUUID()
    const contentBlocks: ContentBlock[] = []
    let textContent = ''
    const toolCalls: Map<string, { name: string; input: Record<string, unknown> }> = new Map()
    let inputTokens = 0
    let outputTokens = 0
    let stopReason: string = 'complete'

    try {
      const stream = this.llmProviderPresenter.startStreamCompletion(
        providerId,
        messages,
        modelId,
        eventId,
        request.temperature ?? 0.6,
        request.max_tokens
      )

      for await (const event of stream) {
        // Handle LLMAgentEvent format from agentLoopHandler
        switch (event.type) {
          case 'response': {
            const data = event.data
            // Handle text content
            if (data.content) {
              textContent += data.content
            }
            // Handle reasoning content
            if (data.reasoning_content) {
              textContent += data.reasoning_content
            }
            // Handle tool calls
            if (data.tool_call === 'start' && data.tool_call_id && data.tool_call_name) {
              toolCalls.set(data.tool_call_id, { name: data.tool_call_name, input: {} })
            }
            if (data.tool_call === 'update' && data.tool_call_id && data.tool_call_params) {
              const toolCall = toolCalls.get(data.tool_call_id)
              if (toolCall) {
                try {
                  toolCall.input = JSON.parse(data.tool_call_params)
                } catch {
                  toolCall.input = { raw: data.tool_call_params }
                }
              }
            }
            // Handle usage
            if (data.totalUsage) {
              inputTokens = data.totalUsage.prompt_tokens || 0
              outputTokens = data.totalUsage.completion_tokens || 0
            }
            break
          }

          case 'end': {
            stopReason = event.data.userStop ? 'stop_sequence' : 'end_turn'
            break
          }

          case 'error':
            throw new Error(event.data.error)
        }
      }

      // Build content blocks
      if (textContent) {
        contentBlocks.push({ type: 'text', text: textContent })
      }

      for (const [id, call] of toolCalls) {
        contentBlocks.push({
          type: 'tool_use',
          id,
          name: call.name,
          input: call.input
        })
      }

      // Ensure at least one content block
      if (contentBlocks.length === 0) {
        contentBlocks.push({ type: 'text', text: '' })
      }

      const usage: ClaudeUsage = {
        input_tokens: inputTokens,
        output_tokens: outputTokens
      }

      const response = buildNonStreamingResponse(
        request.model,
        contentBlocks,
        toolCalls.size > 0 ? 'tool_use' : mapStopReason(stopReason),
        usage
      )

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(response))
    } catch (error) {
      console.error('[AnthropicAPI] Non-streaming error:', error)
      const message = error instanceof Error ? error.message : 'Unknown error'
      this.sendError(res, 500, 'api_error', message)
    }
  }

  /**
   * Handle POST /v1/messages/count_tokens
   */
  private async handleCountTokens(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req)
    let request: ClaudeTokenCountRequest

    try {
      request = JSON.parse(body) as ClaudeTokenCountRequest
    } catch {
      this.sendError(res, 400, 'invalid_request_error', 'Invalid JSON body')
      return
    }

    // Simple token estimation: ~4 characters per token
    let totalChars = 0

    // Count system message
    if (request.system) {
      if (typeof request.system === 'string') {
        totalChars += request.system.length
      } else if (Array.isArray(request.system)) {
        for (const block of request.system) {
          if (block.type === 'text') {
            totalChars += block.text.length
          }
        }
      }
    }

    // Count messages
    for (const msg of request.messages) {
      if (typeof msg.content === 'string') {
        totalChars += msg.content.length
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            totalChars += block.text.length
          }
        }
      }
    }

    const estimatedTokens = Math.max(1, Math.floor(totalChars / 4))

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ input_tokens: estimatedTokens }))
  }

  /**
   * Handle POST /v1/chat/completions (OpenAI format)
   */
  private async handleChatCompletions(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const body = await this.readBody(req)
    let request: OpenAIChatCompletionsRequest

    try {
      request = JSON.parse(body) as OpenAIChatCompletionsRequest
    } catch {
      this.sendOpenAIError(res, 400, 'invalid_request_error', 'Invalid JSON body')
      return
    }

    // Validate required fields
    if (!request.model) {
      this.sendOpenAIError(res, 400, 'invalid_request_error', 'Missing required field: model')
      return
    }
    if (!request.messages || !Array.isArray(request.messages)) {
      this.sendOpenAIError(res, 400, 'invalid_request_error', 'Missing required field: messages')
      return
    }

    // Map model to provider
    const modelMapping = mapClaudeModel(
      request.model,
      this.config.defaultProviderId,
      this.config.defaultModelId
    )

    if (!modelMapping) {
      this.sendOpenAIError(
        res,
        400,
        'invalid_request_error',
        `Unable to map model: ${request.model}. Use format "providerId/modelId" or configure default provider.`
      )
      return
    }

    const { providerId, modelId } = modelMapping

    // Verify provider exists
    try {
      this.llmProviderPresenter.getProviderById(providerId)
    } catch {
      this.sendOpenAIError(res, 400, 'invalid_request_error', `Provider not found: ${providerId}`)
      return
    }

    // Convert request
    const { messages } = convertOpenAIToInternal(request)

    if (request.stream) {
      await this.handleOpenAIStreamingResponse(res, request, providerId, modelId, messages)
    } else {
      await this.handleOpenAINonStreamingResponse(res, request, providerId, modelId, messages)
    }
  }

  /**
   * Handle OpenAI streaming response
   */
  private async handleOpenAIStreamingResponse(
    res: http.ServerResponse,
    request: OpenAIChatCompletionsRequest,
    providerId: string,
    modelId: string,
    messages: ChatMessage[]
  ): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    })

    const builder = new OpenAIStreamingBuilder(request.model)
    const eventId = crypto.randomUUID()

    try {
      // Send initial chunk with role
      res.write(builder.buildInitialChunk())

      // Start stream completion
      const stream = this.llmProviderPresenter.startStreamCompletion(
        providerId,
        messages,
        modelId,
        eventId,
        request.temperature ?? 0.7,
        request.max_tokens ?? 4096
      )

      let inputTokens = 0
      let outputTokens = 0
      let stopReason: string | undefined

      for await (const event of stream) {
        if (res.destroyed) {
          break
        }

        // Handle LLMAgentEvent format from agentLoopHandler
        switch (event.type) {
          case 'response': {
            const data = event.data
            // Handle text content
            if (data.content) {
              res.write(builder.buildContentChunk(data.content))
            }
            // Handle reasoning content
            if (data.reasoning_content) {
              res.write(builder.buildContentChunk(data.reasoning_content))
            }
            // Handle tool calls
            if (data.tool_call === 'start' && data.tool_call_id && data.tool_call_name) {
              res.write(builder.buildToolCallStartChunk(data.tool_call_id, data.tool_call_name))
            }
            if (data.tool_call === 'update' && data.tool_call_id && data.tool_call_params) {
              res.write(builder.buildToolCallArgsChunk(data.tool_call_id, data.tool_call_params))
            }
            // Handle usage
            if (data.totalUsage) {
              inputTokens = data.totalUsage.prompt_tokens || 0
              outputTokens = data.totalUsage.completion_tokens || 0
            }
            break
          }

          case 'end': {
            stopReason = event.data.userStop ? 'stop' : 'stop'
            break
          }

          case 'error':
            // For streaming, we can't send proper error - just end the stream
            console.error('[AnthropicAPI] OpenAI streaming error:', event.data.error)
            break
        }
      }

      // Set usage and send final chunk
      builder.setUsage(inputTokens, outputTokens)
      const finishReason = mapToOpenAIFinishReason(stopReason, builder.hasToolCalls())
      res.write(builder.buildFinalChunk(finishReason))
      res.write(builder.buildDone())
      res.end()
    } catch (error) {
      console.error('[AnthropicAPI] OpenAI streaming error:', error)
      res.write(builder.buildDone())
      res.end()
    }
  }

  /**
   * Handle OpenAI non-streaming response
   */
  private async handleOpenAINonStreamingResponse(
    res: http.ServerResponse,
    request: OpenAIChatCompletionsRequest,
    providerId: string,
    modelId: string,
    messages: ChatMessage[]
  ): Promise<void> {
    const eventId = crypto.randomUUID()
    let textContent = ''
    const toolCalls: OpenAIToolCall[] = []
    const toolCallBuffers: Map<string, { name: string; args: string }> = new Map()
    let inputTokens = 0
    let outputTokens = 0
    let stopReason: string | undefined

    try {
      const stream = this.llmProviderPresenter.startStreamCompletion(
        providerId,
        messages,
        modelId,
        eventId,
        request.temperature ?? 0.7,
        request.max_tokens ?? 4096
      )

      for await (const event of stream) {
        // Handle LLMAgentEvent format from agentLoopHandler
        switch (event.type) {
          case 'response': {
            const data = event.data
            // Handle text content
            if (data.content) {
              textContent += data.content
            }
            // Handle reasoning content
            if (data.reasoning_content) {
              textContent += data.reasoning_content
            }
            // Handle tool calls
            if (data.tool_call === 'start' && data.tool_call_id && data.tool_call_name) {
              toolCallBuffers.set(data.tool_call_id, { name: data.tool_call_name, args: '' })
            }
            if (data.tool_call === 'update' && data.tool_call_id && data.tool_call_params) {
              const buffer = toolCallBuffers.get(data.tool_call_id)
              if (buffer) {
                buffer.args = data.tool_call_params
                // Check if this update completes the tool call
                toolCalls.push({
                  id: data.tool_call_id,
                  type: 'function',
                  function: {
                    name: buffer.name,
                    arguments: data.tool_call_params
                  }
                })
              }
            }
            // Handle usage
            if (data.totalUsage) {
              inputTokens = data.totalUsage.prompt_tokens || 0
              outputTokens = data.totalUsage.completion_tokens || 0
            }
            break
          }

          case 'end': {
            stopReason = event.data.userStop ? 'stop' : 'stop'
            break
          }

          case 'error':
            throw new Error(event.data.error)
        }
      }

      const finishReason = mapToOpenAIFinishReason(stopReason, toolCalls.length > 0)
      const response = buildOpenAIResponse(
        request.model,
        textContent || null,
        toolCalls.length > 0 ? toolCalls : undefined,
        finishReason,
        inputTokens,
        outputTokens
      )

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(response))
    } catch (error) {
      console.error('[AnthropicAPI] OpenAI non-streaming error:', error)
      const message = error instanceof Error ? error.message : 'Unknown error'
      this.sendOpenAIError(res, 500, 'api_error', message)
    }
  }

  /**
   * Handle GET /v1/models
   */
  private async handleListModels(res: http.ServerResponse): Promise<void> {
    try {
      // Get all providers
      const providers = this.llmProviderPresenter.getProviders()
      const models: Array<{
        id: string
        object: string
        created: number
        owned_by: string
      }> = []

      const created = Math.floor(Date.now() / 1000)

      // Fetch models from each enabled provider
      for (const provider of providers) {
        if (!provider.enable) continue

        try {
          // Use getModelList to fetch models for each provider
          const providerModels = await this.llmProviderPresenter.getModelList(provider.id)

          for (const model of providerModels) {
            models.push({
              id: `${provider.id}/${model.id}`,
              object: 'model',
              created,
              owned_by: provider.name || provider.id
            })
          }
        } catch (error) {
          console.error(`[AnthropicAPI] Failed to fetch models for provider ${provider.id}:`, error)
          // Continue with other providers even if one fails
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          object: 'list',
          data: models
        })
      )
    } catch (error) {
      console.error('[AnthropicAPI] Failed to list models:', error)
      const message = error instanceof Error ? error.message : 'Unknown error'
      this.sendError(res, 500, 'api_error', message)
    }
  }

  /**
   * Handle GET /health
   */
  private handleHealth(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        config: {
          port: this.config.port,
          host: this.config.host,
          defaultProviderId: this.config.defaultProviderId,
          defaultModelId: this.config.defaultModelId,
          apiKeyConfigured: !!this.config.apiKey
        }
      })
    )
  }

  /**
   * Handle GET /
   */
  private handleRoot(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        name: 'DeepChat API Server',
        version: '1.0.0',
        description: 'Anthropic and OpenAI compatible API for Claude Code Router integration',
        endpoints: {
          anthropic: {
            messages: '/v1/messages',
            count_tokens: '/v1/messages/count_tokens'
          },
          openai: {
            chat_completions: '/v1/chat/completions',
            models: '/v1/models'
          },
          health: '/health'
        }
      })
    )
  }

  /**
   * Read request body
   */
  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk.toString()
      })
      req.on('end', () => {
        resolve(body)
      })
      req.on('error', reject)
    })
  }

  /**
   * Send error response (Anthropic format)
   */
  private sendError(res: http.ServerResponse, status: number, type: string, message: string): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        type: 'error',
        error: { type, message }
      })
    )
  }

  /**
   * Send error response (OpenAI format)
   */
  private sendOpenAIError(
    res: http.ServerResponse,
    status: number,
    type: string,
    message: string
  ): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        error: {
          message,
          type,
          param: null,
          code: null
        }
      })
    )
  }
}
