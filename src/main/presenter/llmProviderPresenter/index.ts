import {
  ILlmProviderPresenter,
  LLM_PROVIDER,
  LLMResponse,
  MODEL_META,
  OllamaModel,
  ChatMessage,
  LLMAgentEvent,
  KeyStatus,
  LLM_EMBEDDING_ATTRS,
  ModelScopeMcpSyncOptions,
  ModelScopeMcpSyncResult,
  IConfigPresenter,
  ISQLitePresenter,
  AcpWorkdirInfo
} from '@shared/presenter'
import { ProviderChange, ProviderBatchUpdate } from '@shared/provider-operations'
import { eventBus } from '@/eventbus'
import { CONFIG_EVENTS } from '@/events'
import { BaseLLMProvider } from './baseProvider'
import { ProviderConfig, StreamState } from './types'
import { RateLimitManager } from './managers/rateLimitManager'
import { ProviderInstanceManager } from './managers/providerInstanceManager'
import { ModelManager } from './managers/modelManager'
import { OllamaManager } from './managers/ollamaManager'
import { EmbeddingManager } from './managers/embeddingManager'
import { AgentLoopHandler } from './managers/agentLoopHandler'
import { ModelScopeSyncManager } from './managers/modelScopeSyncManager'
import type { OllamaProvider } from './providers/ollamaProvider'
import { ShowResponse } from 'ollama'
import { AcpSessionPersistence } from './agent/acpSessionPersistence'
import { AcpProvider } from './providers/acpProvider'

export class LLMProviderPresenter implements ILlmProviderPresenter {
  private currentProviderId: string | null = null
  private readonly activeStreams: Map<string, StreamState> = new Map()
  private readonly config: ProviderConfig = {
    maxConcurrentStreams: 10
  }
  private readonly rateLimitManager: RateLimitManager
  private readonly providerInstanceManager: ProviderInstanceManager
  private readonly modelManager: ModelManager
  private readonly ollamaManager: OllamaManager
  private readonly embeddingManager: EmbeddingManager
  private readonly agentLoopHandler: AgentLoopHandler
  private readonly modelScopeSyncManager: ModelScopeSyncManager
  private readonly acpSessionPersistence: AcpSessionPersistence

  constructor(configPresenter: IConfigPresenter, sqlitePresenter: ISQLitePresenter) {
    this.rateLimitManager = new RateLimitManager(configPresenter)
    this.acpSessionPersistence = new AcpSessionPersistence(sqlitePresenter)
    this.providerInstanceManager = new ProviderInstanceManager({
      configPresenter,
      activeStreams: this.activeStreams,
      rateLimitManager: this.rateLimitManager,
      getCurrentProviderId: () => this.currentProviderId,
      setCurrentProviderId: (providerId) => {
        this.currentProviderId = providerId
      },
      acpSessionPersistence: this.acpSessionPersistence
    })
    this.modelManager = new ModelManager({
      configPresenter,
      getProviderInstance: this.getProviderInstance.bind(this)
    })
    this.ollamaManager = new OllamaManager({
      getProviderInstance: this.getProviderInstance.bind(this)
    })
    this.embeddingManager = new EmbeddingManager({
      getProviderInstance: this.getProviderInstance.bind(this)
    })
    this.modelScopeSyncManager = new ModelScopeSyncManager({
      configPresenter,
      getProviderInstance: this.getProviderInstance.bind(this)
    })
    this.agentLoopHandler = new AgentLoopHandler({
      configPresenter,
      getProviderInstance: this.getProviderInstance.bind(this),
      activeStreams: this.activeStreams,
      canStartNewStream: this.canStartNewStream.bind(this),
      rateLimitManager: this.rateLimitManager
    })

    this.rateLimitManager.initializeProviderRateLimitConfigs()
    this.providerInstanceManager.init()

    eventBus.on(CONFIG_EVENTS.PROXY_RESOLVED, () => {
      this.providerInstanceManager.handleProxyResolved()
    })

    eventBus.on(CONFIG_EVENTS.PROVIDER_ATOMIC_UPDATE, (change: ProviderChange) => {
      this.providerInstanceManager.handleProviderAtomicUpdate(change)
    })

    eventBus.on(CONFIG_EVENTS.PROVIDER_BATCH_UPDATE, (batchUpdate: ProviderBatchUpdate) => {
      this.providerInstanceManager.handleProviderBatchUpdate(batchUpdate)
    })
  }

  getProviders(): LLM_PROVIDER[] {
    return this.providerInstanceManager.getProviders()
  }

  getCurrentProvider(): LLM_PROVIDER | null {
    if (!this.currentProviderId) {
      return null
    }
    try {
      return this.providerInstanceManager.getProviderById(this.currentProviderId)
    } catch {
      return null
    }
  }

  getProviderById(id: string): LLM_PROVIDER {
    return this.providerInstanceManager.getProviderById(id)
  }

  isAgentProvider(providerId: string): boolean {
    return this.providerInstanceManager.isAgentProvider(providerId)
  }

  async setCurrentProvider(providerId: string): Promise<void> {
    // 如果有正在生成的流，先停止它们
    await this.stopAllStreams()

    const provider = this.getProviderById(providerId)
    if (!provider) {
      throw new Error(`Provider ${providerId} not found`)
    }

    this.currentProviderId = providerId
    // 确保新的 provider 实例已经初始化
    this.getProviderInstance(providerId)
  }

  setProviders(providers: LLM_PROVIDER[]): void {
    this.stopAllStreams()
    this.providerInstanceManager.setProviders(providers)
  }

  public getProviderInstance(providerId: string): BaseLLMProvider {
    return this.providerInstanceManager.getProviderInstance(providerId)
  }

  async getModelList(providerId: string): Promise<MODEL_META[]> {
    return this.modelManager.getModelList(providerId)
  }

  async updateModelStatus(providerId: string, modelId: string, enabled: boolean): Promise<void> {
    await this.modelManager.updateModelStatus(providerId, modelId, enabled)
  }

  /**
   * 更新 provider 的速率限制配置
   */
  updateProviderRateLimit(providerId: string, enabled: boolean, qpsLimit: number): void {
    this.rateLimitManager.updateProviderRateLimit(providerId, enabled, qpsLimit)
  }

  /**
   * 获取 provider 的速率限制状态
   */
  getProviderRateLimitStatus(providerId: string): {
    config: { enabled: boolean; qpsLimit: number }
    currentQps: number
    queueLength: number
    lastRequestTime: number
  } {
    return this.rateLimitManager.getProviderRateLimitStatus(providerId)
  }

  /**
   * 获取所有 provider 的速率限制状态
   */
  getAllProviderRateLimitStatus(): Record<
    string,
    {
      config: { enabled: boolean; qpsLimit: number }
      currentQps: number
      queueLength: number
      lastRequestTime: number
    }
  > {
    return this.rateLimitManager.getAllProviderRateLimitStatus()
  }

  isGenerating(eventId: string): boolean {
    return this.activeStreams.has(eventId)
  }

  getStreamState(eventId: string): StreamState | null {
    return this.activeStreams.get(eventId) || null
  }

  async stopStream(eventId: string): Promise<void> {
    const stream = this.activeStreams.get(eventId)
    if (stream) {
      stream.abortController.abort()
      // Deletion is handled by the consuming loop in threadPresenter upon receiving the 'end' event or abortion signal
    }
  }

  private async stopAllStreams(): Promise<void> {
    const promises = Array.from(this.activeStreams.keys()).map((eventId) =>
      this.stopStream(eventId)
    )
    await Promise.all(promises)
  }

  private canStartNewStream(): boolean {
    return this.activeStreams.size < this.config.maxConcurrentStreams
  }

  async *startStreamCompletion(
    providerId: string,
    initialMessages: ChatMessage[],
    modelId: string,
    eventId: string,
    temperature: number = 0.6,
    maxTokens: number = 4096,
    enabledMcpTools?: string[],
    thinkingBudget?: number,
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high',
    verbosity?: 'low' | 'medium' | 'high',
    enableSearch?: boolean,
    forcedSearch?: boolean,
    searchStrategy?: 'turbo' | 'max',
    conversationId?: string
  ): AsyncGenerator<LLMAgentEvent, void, unknown> {
    yield* this.agentLoopHandler.startStreamCompletion(
      providerId,
      initialMessages,
      modelId,
      eventId,
      temperature,
      maxTokens,
      enabledMcpTools,
      thinkingBudget,
      reasoningEffort,
      verbosity,
      enableSearch,
      forcedSearch,
      searchStrategy,
      conversationId
    )
  }

  async *runSlashCommand(
    providerId: string,
    modelId: string,
    eventId: string,
    sessionId: string,
    commandName: string,
    userInput?: string,
    conversationId?: string
  ): AsyncGenerator<LLMAgentEvent, void, unknown> {
    const provider = this.getProviderInstance(providerId)
    if (!(provider instanceof AcpProvider)) {
      throw new Error('Slash commands are only supported for ACP provider')
    }

    const abortController = new AbortController()
    this.activeStreams.set(eventId, {
      isGenerating: true,
      providerId,
      modelId,
      abortController,
      provider
    })

    const totalUsage = {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      context_length: 0
    }
    const toolCallChunks: Record<
      string,
      {
        name: string
        arguments_chunk: string
      }
    > = {}

    try {
      const stream = provider.runSlashCommand(sessionId, commandName, userInput, conversationId)
      for await (const chunk of stream) {
        if (abortController.signal.aborted) {
          break
        }
        switch (chunk.type) {
          case 'text':
            if (chunk.content) {
              yield {
                type: 'response',
                data: {
                  eventId,
                  content: chunk.content
                }
              }
            }
            break
          case 'reasoning':
            if (chunk.reasoning_content) {
              yield {
                type: 'response',
                data: {
                  eventId,
                  reasoning_content: chunk.reasoning_content
                }
              }
            }
            break
          case 'tool_call_start':
            if (chunk.tool_call_id && chunk.tool_call_name) {
              toolCallChunks[chunk.tool_call_id] = {
                name: chunk.tool_call_name,
                arguments_chunk: ''
              }
              yield {
                type: 'response',
                data: {
                  eventId,
                  tool_call: 'start',
                  tool_call_id: chunk.tool_call_id,
                  tool_call_name: chunk.tool_call_name,
                  tool_call_params: ''
                }
              }
            }
            break
          case 'tool_call_chunk':
            if (
              chunk.tool_call_id &&
              chunk.tool_call_arguments_chunk &&
              toolCallChunks[chunk.tool_call_id]
            ) {
              toolCallChunks[chunk.tool_call_id].arguments_chunk += chunk.tool_call_arguments_chunk
              yield {
                type: 'response',
                data: {
                  eventId,
                  tool_call: 'update',
                  tool_call_id: chunk.tool_call_id,
                  tool_call_name: toolCallChunks[chunk.tool_call_id].name,
                  tool_call_params: toolCallChunks[chunk.tool_call_id].arguments_chunk
                }
              }
            }
            break
          case 'tool_call_end':
            if (chunk.tool_call_id && toolCallChunks[chunk.tool_call_id]) {
              const params =
                chunk.tool_call_arguments_complete ??
                toolCallChunks[chunk.tool_call_id].arguments_chunk
              yield {
                type: 'response',
                data: {
                  eventId,
                  tool_call: 'update',
                  tool_call_id: chunk.tool_call_id,
                  tool_call_name: toolCallChunks[chunk.tool_call_id].name,
                  tool_call_params: params
                }
              }
              delete toolCallChunks[chunk.tool_call_id]
            }
            break
          case 'permission': {
            const permission = chunk.permission
            const permissionType = permission.permissionType ?? 'read'
            const description = permission.description ?? ''
            const toolName = permission.tool_call_name ?? permission.tool_call_id
            const serverName =
              permission.server_name ?? permission.agentName ?? permission.providerName ?? ''

            yield {
              type: 'response',
              data: {
                eventId,
                tool_call: 'permission-required',
                tool_call_id: permission.tool_call_id,
                tool_call_name: toolName,
                tool_call_params: permission.tool_call_params,
                tool_call_server_name: serverName,
                tool_call_server_icons: permission.server_icons,
                tool_call_server_description: permission.server_description ?? permission.agentName,
                tool_call_response: description,
                permission_request: {
                  toolName,
                  serverName,
                  permissionType,
                  description,
                  providerId: permission.providerId,
                  requestId: permission.requestId,
                  sessionId: permission.sessionId,
                  agentId: permission.agentId,
                  agentName: permission.agentName,
                  conversationId: permission.conversationId,
                  options: permission.options,
                  rememberable: permission.metadata?.rememberable === false ? false : true
                }
              }
            }
            break
          }
          case 'usage':
            if (chunk.usage) {
              totalUsage.prompt_tokens += chunk.usage.prompt_tokens
              totalUsage.completion_tokens += chunk.usage.completion_tokens
              totalUsage.total_tokens += chunk.usage.total_tokens
              yield {
                type: 'response',
                data: {
                  eventId,
                  totalUsage: { ...totalUsage }
                }
              }
            }
            break
          case 'image_data':
            if (chunk.image_data) {
              yield {
                type: 'response',
                data: {
                  eventId,
                  image_data: chunk.image_data
                }
              }
            }
            break
          case 'rate_limit':
            if (chunk.rate_limit) {
              yield {
                type: 'response',
                data: {
                  eventId,
                  rate_limit: chunk.rate_limit
                }
              }
            }
            break
          case 'error':
            yield {
              type: 'error',
              data: {
                eventId,
                error: chunk.error_message || 'Provider stream error'
              }
            }
            break
          case 'stop':
            // stop event will be handled by finally block via end event
            break
        }
      }
    } finally {
      this.activeStreams.delete(eventId)
      yield { type: 'end', data: { eventId, userStop: abortController.signal.aborted } }
    }
  }

  // 非流式方法
  async generateCompletion(
    providerId: string,
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    modelId: string,
    temperature?: number,
    maxTokens?: number
  ): Promise<string> {
    // Record input messages to the large model
    console.log('generateCompletion', providerId, modelId, temperature, maxTokens, messages)
    const provider = this.getProviderInstance(providerId)
    const response = await provider.completions(messages, modelId, temperature, maxTokens)
    return response.content
  }

  async generateSummary(
    providerId: string,
    text: string,
    modelId: string,
    temperature?: number,
    maxTokens?: number
  ): Promise<LLMResponse> {
    const provider = this.getProviderInstance(providerId)
    return provider.summaries(text, modelId, temperature, maxTokens)
  }

  async generateText(
    providerId: string,
    prompt: string,
    modelId: string,
    temperature?: number,
    maxTokens?: number
  ): Promise<LLMResponse> {
    const provider = this.getProviderInstance(providerId)
    return provider.generateText(prompt, modelId, temperature, maxTokens)
  }

  async generateCompletionStandalone(
    providerId: string,
    messages: ChatMessage[],
    modelId: string,
    temperature?: number,
    maxTokens?: number
  ): Promise<string> {
    const provider = this.getProviderInstance(providerId)
    let response = ''
    try {
      const llmResponse = await provider.completions(messages, modelId, temperature, maxTokens)
      response = llmResponse.content

      return response
    } catch (error) {
      console.error('Stream error:', error)
      return ''
    }
  }

  // 配置相关方法
  setMaxConcurrentStreams(max: number): void {
    this.config.maxConcurrentStreams = max
  }

  getMaxConcurrentStreams(): number {
    return this.config.maxConcurrentStreams
  }

  async check(
    providerId: string,
    modelId?: string
  ): Promise<{ isOk: boolean; errorMsg: string | null }> {
    try {
      const provider = this.getProviderInstance(providerId)

      // 如果提供了modelId，使用completions方法进行测试
      if (modelId) {
        try {
          const testMessage = [{ role: 'user' as const, content: 'hi' }]
          const response: LLMResponse | null = await Promise.race([
            provider.completions(testMessage, modelId, 0.1, 10),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 60000))
          ])
          // 检查响应是否有效
          if (
            response &&
            (response.content || response.content === '' || response.reasoning_content)
          ) {
            return { isOk: true, errorMsg: null }
          } else {
            return { isOk: false, errorMsg: 'Model response is invalid' }
          }
        } catch (error) {
          console.error(`Model ${modelId} check failed:`, error)
          const errorMessage = error instanceof Error ? error.message : String(error)
          return { isOk: false, errorMsg: `Model test failed: ${errorMessage}` }
        }
      } else {
        // 如果没有提供modelId，使用provider自己的check方法进行基本验证
        console.log(
          `[LLMProviderPresenter] No modelId provided, using provider's own check method for ${providerId}`
        )
        try {
          return await provider.check()
        } catch (error) {
          console.error(`Provider ${providerId} check failed:`, error)
          const errorMessage = error instanceof Error ? error.message : String(error)
          return { isOk: false, errorMsg: `Provider check failed: ${errorMessage}` }
        }
      }
    } catch (error) {
      console.error(`Provider ${providerId} check failed:`, error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { isOk: false, errorMsg: `Provider check failed: ${errorMessage}` }
    }
  }

  async getKeyStatus(providerId: string): Promise<KeyStatus | null> {
    const provider = this.getProviderInstance(providerId)
    return provider.getKeyStatus()
  }

  async refreshModels(providerId: string): Promise<void> {
    try {
      const provider = this.getProviderInstance(providerId)
      await provider.refreshModels()
    } catch (error) {
      console.error(`Failed to refresh models for provider ${providerId}:`, error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      throw new Error(`Model refresh failed: ${errorMessage}`)
    }
  }

  async addCustomModel(
    providerId: string,
    model: Omit<MODEL_META, 'providerId' | 'isCustom' | 'group'>
  ): Promise<MODEL_META> {
    return this.modelManager.addCustomModel(providerId, model)
  }

  async removeCustomModel(providerId: string, modelId: string): Promise<boolean> {
    return this.modelManager.removeCustomModel(providerId, modelId)
  }

  async updateCustomModel(
    providerId: string,
    modelId: string,
    updates: Partial<MODEL_META>
  ): Promise<boolean> {
    return this.modelManager.updateCustomModel(providerId, modelId, updates)
  }

  async getCustomModels(providerId: string): Promise<MODEL_META[]> {
    return this.modelManager.getCustomModels(providerId)
  }

  async summaryTitles(
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
    providerId: string,
    modelId: string
  ): Promise<string> {
    const provider = this.getProviderInstance(providerId)
    return provider.summaryTitles(messages, modelId)
  }

  // 获取 OllamaProvider 实例
  getOllamaProviderInstance(providerId: string): OllamaProvider | null {
    return this.ollamaManager.getOllamaProviderInstance(providerId)
  }
  // ollama api
  listOllamaModels(providerId: string): Promise<OllamaModel[]> {
    return this.ollamaManager.listOllamaModels(providerId)
  }
  showOllamaModelInfo(providerId: string, modelName: string): Promise<ShowResponse> {
    return this.ollamaManager.showOllamaModelInfo(providerId, modelName)
  }
  listOllamaRunningModels(providerId: string): Promise<OllamaModel[]> {
    return this.ollamaManager.listOllamaRunningModels(providerId)
  }
  pullOllamaModels(providerId: string, modelName: string): Promise<boolean> {
    return this.ollamaManager.pullOllamaModels(providerId, modelName)
  }
  /**
   * 获取文本的 embedding 表示
   * @param providerId 提供商ID
   * @param modelId 模型ID
   * @param texts 文本数组
   * @returns embedding 数组
   */
  async getEmbeddings(providerId: string, modelId: string, texts: string[]): Promise<number[][]> {
    return this.embeddingManager.getEmbeddings(providerId, modelId, texts)
  }

  /**
   * 获取指定模型的 embedding 维度
   * @param providerId 提供商ID
   * @param modelId 模型ID
   * @returns 模型的 embedding 维度
   */
  async getDimensions(
    providerId: string,
    modelId: string
  ): Promise<{ data: LLM_EMBEDDING_ATTRS; errorMsg?: string }> {
    return this.embeddingManager.getDimensions(providerId, modelId)
  }

  async syncModelScopeMcpServers(
    providerId: string,
    syncOptions?: ModelScopeMcpSyncOptions
  ): Promise<ModelScopeMcpSyncResult> {
    return this.modelScopeSyncManager.syncModelScopeMcpServers(providerId, syncOptions)
  }

  async getAcpWorkdir(conversationId: string, agentId: string): Promise<AcpWorkdirInfo> {
    const record = await this.acpSessionPersistence.getSessionData(conversationId, agentId)
    const path = this.acpSessionPersistence.resolveWorkdir(record?.workdir)
    const isCustom = Boolean(record?.workdir && record.workdir.trim().length > 0)
    return { path, isCustom }
  }

  async setAcpWorkdir(
    conversationId: string,
    agentId: string,
    workdir: string | null
  ): Promise<void> {
    const provider = this.getAcpProviderInstance()
    if (provider) {
      await provider.updateAcpWorkdir(conversationId, agentId, workdir)
      return
    }

    const trimmed = workdir?.trim() ? workdir : null
    await this.acpSessionPersistence.updateWorkdir(conversationId, agentId, trimmed)
  }

  async resolveAgentPermission(requestId: string, granted: boolean): Promise<void> {
    const provider = this.getAcpProviderInstance()
    if (!provider) {
      throw new Error('ACP provider unavailable')
    }
    await provider.resolvePermissionRequest(requestId, granted)
  }

  private getAcpProviderInstance(): AcpProvider | null {
    try {
      const instance = this.getProviderInstance('acp')
      return instance instanceof AcpProvider ? (instance as AcpProvider) : null
    } catch (error) {
      console.warn('[LLMProviderPresenter] ACP provider unavailable:', error)
      return null
    }
  }
}
