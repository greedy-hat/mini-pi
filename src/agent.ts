// Coordinates model responses and tool execution into a multi-step agent loop.

import { buildAssistantMessage, buildToolResultMessage, stream } from './llm.js'
import type { Context, Model } from './llm.js'

/** Describes a tool that can be selected and executed by the agent. */
export type AgentTool = {
  name: string
  description: string
  parameters: Record<string, unknown>
  execute: (toolArguments: unknown, signal?: AbortSignal) => Promise<string>
}

/** Events emitted while the agent processes one user turn. */
export type AgentEvent =
  | { type: 'assistant_text'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; name: string; result: string }
  | { type: 'turn_end'; stopReason: 'end_turn' | 'max_tokens' | 'aborted' | 'error' }

/** Internal representation of a tool call collected from one model response. */
type ToolCall = {
  id: string
  name: string
  args: unknown
  error?: string
}

/** Stop reasons returned by the streaming model adapter. */
type StreamStopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const COMPACTION_MESSAGE_THRESHOLD = 50
const RECENT_MESSAGE_COUNT = 20

/**
 * Summarize older messages when the conversation exceeds the compaction threshold.
 * The most recent messages are kept verbatim so the next turn retains local context.
 */
async function compactContext(model: Model, context: Context, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return
  if (context.messages.length < COMPACTION_MESSAGE_THRESHOLD) return

  const historicalMessages = context.messages.slice(0, -RECENT_MESSAGE_COUNT)
  const recentMessages = context.messages.slice(-RECENT_MESSAGE_COUNT)

  const conversationText = historicalMessages
    .map(message => `${message.role}: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`)
    .join('\n')

  const summaryRequestContext: Context = {
    systemPrompt: '',
    messages: [{ role: 'user', content: conversationText }],
  }

  let contextSummary = ''
  let summaryFailed = false
  for await (const event of stream(model, summaryRequestContext, { signal })) {
    if (event.type === 'text_delta') {
      contextSummary += event.delta
    } else if (event.type === 'error' || (event.type === 'done' && event.stopReason === 'aborted')) {
      summaryFailed = true
      break
    }
  }

  if (summaryFailed || !contextSummary) return

  context.messages = [
    { role: 'user', content: `[context summary]\n${contextSummary}` },
    ...recentMessages,
  ]
}

/**
 * Run the model/tool loop and expose normalized events to the terminal UI.
 * Tool results are appended to the context before the next model request.
 */
export async function* runAgent(
    model: Model,
    context: Context,
    tools: AgentTool[],
    signal?: AbortSignal
): AsyncGenerator<AgentEvent> {
    const toolsByName = new Map(tools.map(tool => [tool.name, tool]))
    const toolDefinitions = tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
    }))

    while (true) {
        // Keep the request context bounded before each model call.
        await compactContext(model, context, signal)

        let assistantText = ''
        let stopReason: StreamStopReason = 'end_turn'
        const toolCalls: ToolCall[] = []

        for await (const event of stream(model, context, { tools: toolDefinitions, signal })) {
            // Accumulate the current assistant turn while forwarding events immediately.
            if (event.type === 'text_delta') {
                assistantText += event.delta
                yield { type: 'assistant_text', delta: event.delta }
            } else if (event.type === 'tool_call') {
                toolCalls.push({ id: event.id, name: event.name, args: event.args, error: event.error })
                yield { type: 'tool_call', id: event.id, name: event.name, args: event.args }
            } else if (event.type === 'done') {
                stopReason = event.stopReason
                if (event.stopReason === 'aborted') {
                    context.messages.push(buildAssistantMessage(assistantText, []))
                    yield { type: 'turn_end', stopReason: 'aborted' }
                    return
                }
            } else if (event.type === 'error') {
                context.messages.push(buildAssistantMessage(assistantText, []))
                yield { type: 'assistant_text', delta: `\n[error] ${event.error}` }
                yield { type: 'turn_end', stopReason: 'error' }
                return
            }
        }

        context.messages.push(buildAssistantMessage(assistantText, toolCalls))

        // Incomplete tool arguments must not be executed after a max-token cutoff.
        if (stopReason === 'max_tokens' && toolCalls.length > 0) {
            const toolResults = toolCalls.map(toolCall => ({
                tool_use_id: toolCall.id,
                content: `error: output truncated by max_tokens, tool "${toolCall.name}" args may be incomplete.`,
            }))
            context.messages.push(buildToolResultMessage(toolResults))
            for (let toolCallIndex = 0; toolCallIndex < toolCalls.length; toolCallIndex++) {
                yield {
                    type: 'tool_result',
                    id: toolCalls[toolCallIndex].id,
                    name: toolCalls[toolCallIndex].name,
                    result: toolResults[toolCallIndex].content,
                }
            }
            continue
        }

        const turnEndReason = stopReason === 'tool_use' ? 'end_turn' : stopReason
        if (toolCalls.length === 0) {
            yield { type: 'turn_end', stopReason: turnEndReason }
            return
        }

        const toolResults: { tool_use_id: string; content: string }[] = []
        // Execute each requested tool and report its result to the caller.
        for (const toolCall of toolCalls) {
            const selectedTool = toolsByName.get(toolCall.name)
            let toolResult: string
            if (toolCall.error) {
                toolResult = `Error: ${toolCall.error}`
            } else if (!selectedTool) {
                toolResult = `Error: Unknown tool "${toolCall.name}"`
            } else {
                try {
                    toolResult = await selectedTool.execute(toolCall.args, signal)
                } catch (error: unknown) {
                    toolResult = `Error occurred while executing tool "${toolCall.name}": ${errorMessage(error)}`
                }
            }
            toolResults.push({ tool_use_id: toolCall.id, content: toolResult })
            yield { type: 'tool_result', id: toolCall.id, name: toolCall.name, result: toolResult }
            if (signal?.aborted) {
                break
            }
        }

        for (const toolCall of toolCalls.slice(toolResults.length)) {
            toolResults.push({ tool_use_id: toolCall.id, content: 'error: aborted' })
            yield {
                type: 'tool_result',
                id: toolCall.id,
                name: toolCall.name,
                result: 'error: aborted',
            }
        }

        context.messages.push(buildToolResultMessage(toolResults))

    }
}
