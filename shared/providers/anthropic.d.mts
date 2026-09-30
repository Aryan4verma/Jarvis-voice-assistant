import type { AICompletionReason, AIError, AIMessage, AIProviderInfo, AIUsage } from '../ai.mjs'
export function anthropicStopReason(value: unknown): AICompletionReason
export function anthropicUsage(usage: unknown, cost?: unknown): AIUsage | undefined
export function anthropicError(error: unknown, providerId: string): AIError
export function claudeInfo(providerId: string, modelId: string, kind: 'chat' | 'agent'): AIProviderInfo
export function anthropicContent(content: AIMessage['content']): unknown
