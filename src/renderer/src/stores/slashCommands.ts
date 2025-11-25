import { ref, onUnmounted } from 'vue'
import { defineStore } from 'pinia'
import type {
  AgentSessionCommandsPayload,
  AgentSlashCommand
} from '@shared/types/core/agent-events'
import { ACP_EVENTS } from '@/events'

type SlashCommandState = {
  sessionId: string
  agentId: string
  commands: AgentSlashCommand[]
}

export const useSlashCommandsStore = defineStore('slashCommands', () => {
  const commandsByThread = ref(new Map<string, SlashCommandState>())

  const setCommands = (payload: AgentSessionCommandsPayload) => {
    if (!payload.conversationId) return
    const next = new Map(commandsByThread.value)
    if (!payload.commands.length || !payload.sessionId) {
      next.delete(payload.conversationId)
      commandsByThread.value = next
      return
    }

    next.set(payload.conversationId, {
      sessionId: payload.sessionId,
      agentId: payload.agentId,
      commands: payload.commands
    })
    commandsByThread.value = next
  }

  const getCommands = (threadId: string): SlashCommandState | null => {
    return commandsByThread.value.get(threadId) ?? null
  }

  const clearThread = (threadId: string) => {
    const next = new Map(commandsByThread.value)
    next.delete(threadId)
    commandsByThread.value = next
  }

  const ipcRenderer = window.electron?.ipcRenderer
  const handleCommands = (_event: unknown, payload: AgentSessionCommandsPayload) => {
    setCommands(payload)
  }

  if (ipcRenderer) {
    ipcRenderer.on(ACP_EVENTS.SESSION_COMMANDS, handleCommands)
  }

  onUnmounted(() => {
    ipcRenderer?.removeListener(ACP_EVENTS.SESSION_COMMANDS, handleCommands)
  })

  return {
    commandsByThread,
    setCommands,
    getCommands,
    clearThread
  }
})
