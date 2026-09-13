
// Defines model-facing message types and an OpenAI-compatible streaming adapter.

/** Configuration required to send requests to a chat-completions endpoint. */
export type Model = {
    apiKey: string
    model: string
    baseUrl?: string
    maxTokens?: number
}

/** A text, tool-use, or tool-result block in the internal message format. */
export type ContentBlock =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'tool_result'; tool_use_id: string; content: string }

/** A conversation message before provider-specific conversion. */
export type Message = {
    role: 'user' | 'assistant' | 'system'
    content: string | ContentBlock[]
}

/** Conversation state shared across agent turns. */
export type Context = {
    systemPrompt?: string
    messages: Message[]
}

/** Convert internal messages into the OpenAI-compatible request format. */
export function contextToOpenAIMessages(context: Context): Record<string, unknown>[] {
    const messages: Record<string, unknown>[] = []
    if (context.systemPrompt) {
        messages.push({ role: 'system', content: context.systemPrompt })
    }

    for (const message of context.messages) {
        if (typeof message.content === 'string') {
            messages.push({ role: message.role, content: message.content })
            continue
        }

        const contentBlocks = message.content
        if (message.role === 'assistant') {
            // OpenAI expects assistant tool calls in a dedicated tool_calls array.
            const toolCalls: Record<string, unknown>[] = []
            let textContent = ''
            for (const block of contentBlocks) {
                if (block.type === 'text') {
                    textContent += block.text
                } else if (block.type === 'tool_use') {
                    toolCalls.push({
                        id: block.id,
                        type: 'function',
                        function: {
                            name: block.name,
                            arguments: JSON.stringify(block.input),
                        },
                    })
                }
            }
            const content = textContent || (toolCalls.length ? null : '')
            messages.push({ role: 'assistant', content, tool_calls: toolCalls.length ? toolCalls : undefined })
        } else {
            // Tool results are sent as tool messages; text blocks remain user messages.
            for (const block of contentBlocks) {
                if (block.type === 'tool_result') {
                    messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content })
                } else if (block.type === 'text') {
                    messages.push({ role: 'user', content: block.text })
                }
            }
        }
    }

    return messages
}

/** Normalized events emitted while reading the provider's SSE stream. */
export type StreamEvent =
    | { type: 'text_delta'; delta: string }
    | { type: 'tool_call'; id: string; name: string; args: unknown; error?: string }
    | { type: 'done'; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted' }
    | { type: 'error'; error: string }

/** Tool schema included in a model request. */
export type ToolDef = {
    name: string
    description: string
    parameters: Record<string, unknown>
}

/** Minimal shape of a streamed chat-completions chunk. */
type OpenAIChunk = {
    choices: Array<{
        delta?: {
            content?: string
            tool_calls?: Array<{
                index?: number
                id?: string
                function?: {
                    name?: string
                    arguments?: string
                }
            }>
        }
        finish_reason?: string
    }>
}

/** Accumulates fragmented arguments for one streamed tool call. */
type ToolCallBuffer = {
    id: string
    name: string
  argumentsBuffer: string
}

/** Parsed output from one SSE data line. */
type ParsedSSELine = {
    textDelta: string | null
    stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | null
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/**
 * Parse one SSE payload and update any tool-call argument buffers it contains.
 */
function handleSSELine(
    data: string,
    toolCallBuffers: Map<number, ToolCallBuffer>,
): ParsedSSELine {
    let chunk: OpenAIChunk
    try {
        chunk = JSON.parse(data) as OpenAIChunk
    } catch {
        return { textDelta: null, stopReason: null }
    }

    const choice = chunk.choices[0]
    if (!choice) {
        return { textDelta: null, stopReason: null }
    }

    let textDelta: string | null = null
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | null = null

    if (choice.delta?.content) {
        textDelta = choice.delta.content
    }

    if (choice.delta?.tool_calls) {
        for (const toolCall of choice.delta.tool_calls) {
            const toolCallIndex = toolCall.index ?? 0
            if (!toolCallBuffers.has(toolCallIndex)) {
                toolCallBuffers.set(toolCallIndex, {
                    id: toolCall.id ?? `call_${toolCallIndex}`,
                    name: '',
                    argumentsBuffer: '',
                })
            }
            const toolCallBuffer = toolCallBuffers.get(toolCallIndex)!
            if (toolCall.id) toolCallBuffer.id = toolCall.id
            if (toolCall.function?.name) toolCallBuffer.name = toolCall.function.name
            if (toolCall.function?.arguments) {
                toolCallBuffer.argumentsBuffer += toolCall.function.arguments
            }
        }
    }

    if (choice.finish_reason === 'tool_calls') {
        stopReason = 'tool_use'
    } else if (choice.finish_reason === 'length') {
        stopReason = 'max_tokens'
    }

    return { textDelta, stopReason }
}

/** Convert buffered tool-call fragments into complete tool-call events. */
function flushToolCalls(
    toolCallBuffers: Map<number, ToolCallBuffer>,
): { id: string; name: string; args: unknown; error?: string }[] {
    const completedToolCalls: { id: string; name: string; args: unknown; error?: string }[] = []
    for (const [, toolCall] of [...toolCallBuffers].sort((a, b) => a[0] - b[0])) {
        let parsedArguments: unknown = {}
        let parseError: string | undefined
        if (toolCall.argumentsBuffer) {
            try {
                parsedArguments = JSON.parse(toolCall.argumentsBuffer)
            } catch {
                parseError = 'Invalid JSON in tool call arguments'
            }
        }
        if (!toolCall.name) parseError = 'Tool call is missing a function name'
        completedToolCalls.push({
            id: toolCall.id,
            name: toolCall.name,
            args: parsedArguments,
            ...(parseError ? { error: parseError } : {}),
        })
    }
    return completedToolCalls
}

/**
 * Send a streaming chat-completions request and normalize its SSE events.
 * Network and HTTP failures are returned as error events instead of thrown.
 */
export async function* stream(
    model: Model,
    context: Context,
    options: { tools?: ToolDef[]; signal?: AbortSignal } = {}
): AsyncGenerator<StreamEvent> {
    const requestUrl = `${model.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`
    const messages = contextToOpenAIMessages(context)

    const requestBody: Record<string, unknown> = {
        model: model.model,
        stream: true,
        messages
    }
    if (model.maxTokens) {
        requestBody.max_tokens = model.maxTokens
    }
    if (options.tools?.length) {
        requestBody.tools = options.tools.map(tool => ({
            type: 'function',
            function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters
            }
        }))
    }

    let response: Response
    try {
        response = await fetch(requestUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${model.apiKey}`
            },
            body: JSON.stringify(requestBody),
            signal: options.signal
        })
    } catch (error: unknown) {
        if (options.signal?.aborted) {
            yield { type: 'done', stopReason: 'aborted' }
            return
        }
        yield { type: 'error', error: `Network error: ${errorMessage(error)}` }
        return
    }

    if (!response.ok || !response.body) {
        const responseErrorText = await response.text().catch(() => 'Unknown error')
        yield { type: 'error', error: `HTTP error ${response.status}: ${responseErrorText}` }
        return
    }

    const streamReader = response.body.getReader()
    const textDecoder = new TextDecoder('utf-8')
    let sseBuffer = ''
    let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn'
    const toolCallBuffers = new Map<number, ToolCallBuffer>()

    try {
        while (true) {
            const { done, value } = await streamReader.read()
            if (done) {
                break
            }
            sseBuffer += textDecoder.decode(value, { stream: true })

            let newlineIndex: number
            while ((newlineIndex = sseBuffer.indexOf('\n')) >= 0) {
                const sseLine = sseBuffer.slice(0, newlineIndex).trim()
                sseBuffer = sseBuffer.slice(newlineIndex + 1)
                // Ignore keep-alive lines and the provider's terminal marker.
                if (!sseLine.startsWith('data: ')) continue
                const eventData = sseLine.slice(6)
                if (eventData === '[DONE]') continue

                const parsedEvent = handleSSELine(eventData, toolCallBuffers)
                if (parsedEvent.textDelta) {
                    yield { type: 'text_delta', delta: parsedEvent.textDelta }
                }
                if (parsedEvent.stopReason) {
                    stopReason = parsedEvent.stopReason
                }
            }
        }
    } catch (error: unknown) {
        if (options.signal?.aborted) {
            yield { type: 'done', stopReason: 'aborted' }
            return
        }
        yield { type: 'error', error: errorMessage(error) }
        return
    }

    for (const toolCall of flushToolCalls(toolCallBuffers)) {
        yield { type: 'tool_call', ...toolCall }
    }

    yield { type: 'done', stopReason }
}

/** Build the internal assistant message from text and completed tool calls. */
export function buildAssistantMessage(
    assistantText: string,
    toolCalls: { id: string; name: string; args: unknown }[]
): Message {
    const contentBlocks: ContentBlock[] = []
    if (assistantText) {
        contentBlocks.push({ type: 'text', text: assistantText })
    }
    for (const toolCall of toolCalls) {
        contentBlocks.push({ type: 'tool_use', id: toolCall.id, name: toolCall.name, input: toolCall.args })
    }
    return { role: 'assistant', content: contentBlocks }
}

/** Build the internal message containing tool results for the next turn. */
export function buildToolResultMessage(
    toolResults: { tool_use_id: string; content: string }[]
): Message {
    return {
        role: 'user',
        content: toolResults.map(toolResult => ({
            type: 'tool_result' as const,
            tool_use_id: toolResult.tool_use_id,
            content: toolResult.content
        }))
    }
}
