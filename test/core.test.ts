import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runAgent, type AgentTool } from '../src/agent.js'
import {
  buildAssistantMessage,
  buildToolResultMessage,
  contextToOpenAIMessages,
  stream,
} from '../src/llm.js'
import { loadSession, persistSession, startNewSession } from '../src/cli.js'
import { builtInTools } from '../src/tools.js'

const model = {
  apiKey: 'test-key',
  model: 'test-model',
  baseUrl: 'https://example.test/v1',
}

function createSseResponse(...sseChunks: object[]): Response {
  const sseLines = sseChunks.map(sseChunk => 'data: ' + JSON.stringify(sseChunk))
  sseLines.push('data: [DONE]', '')
  return new Response(sseLines.join('\n'), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function collectEvents<T>(events: AsyncIterable<T>): Promise<T[]> {
  const collectedEvents: T[] = []
  for await (const event of events) {
    collectedEvents.push(event)
  }
  return collectedEvents
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('LLM message conversion', () => {
  it('converts assistant tool calls and tool results to OpenAI messages', () => {
    const messages = contextToOpenAIMessages({
      systemPrompt: 'system',
      messages: [
        { role: 'user', content: 'hello' },
        buildAssistantMessage('thinking', [
          { id: 'call-1', name: 'readFile', args: { path: 'README.md' } },
        ]),
        buildToolResultMessage([
          { tool_use_id: 'call-1', content: 'file contents' },
        ]),
      ],
    })

    expect(messages).toEqual([
      { role: 'system', content: 'system' },
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: 'thinking',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: {
              name: 'readFile',
              arguments: '{"path":"README.md"}',
            },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'file contents' },
    ])
  })

})

describe('stream', () => {
  it('emits text and a normal completion event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        createSseResponse(
          { choices: [{ delta: { content: 'hello' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ),
      ),
    )

    const events = await collectEvents(stream(model, { messages: [] }))

    expect(events).toEqual([
      { type: 'text_delta', delta: 'hello' },
      { type: 'done', stopReason: 'end_turn' },
    ])
  })

  it('preserves a max-token completion reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        createSseResponse({ choices: [{ delta: {}, finish_reason: 'length' }] }),
      ),
    )

    const events = await collectEvents(stream(model, { messages: [] }))

    expect(events).toEqual([{ type: 'done', stopReason: 'max_tokens' }])
  })

  it('marks malformed tool arguments as invalid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        createSseResponse(
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call-invalid',
                  function: { name: 'echo', arguments: '{invalid' },
                }],
              },
            }],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ),
      ),
    )

    const events = await collectEvents(stream(model, { messages: [] }))

    expect(events).toContainEqual({
      type: 'tool_call',
      id: 'call-invalid',
      name: 'echo',
      args: {},
      error: 'Invalid JSON in tool call arguments',
    })
  })
})

describe('runAgent', () => {
  it('executes a tool call and continues with the next model turn', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createSseResponse(
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-1',
                      function: {
                        name: 'echo',
                        arguments: '{"value":"x"}',
                      },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ),
      )
      .mockResolvedValueOnce(
        createSseResponse(
          { choices: [{ delta: { content: 'done' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    const echoTool: AgentTool = {
      name: 'echo',
      description: 'Echo a value',
      parameters: { type: 'object' },
      execute: vi.fn(async (toolArguments: unknown) => 'executed ' + JSON.stringify(toolArguments)),
    }
    const context = {
      messages: [{ role: 'user' as const, content: 'run echo' }],
    }

    const events = await collectEvents(runAgent(model, context, [echoTool]))

    expect(events).toContainEqual({
      type: 'tool_call',
      id: 'call-1',
      name: 'echo',
      args: { value: 'x' },
    })
    expect(events).toContainEqual({
      type: 'tool_result',
      id: 'call-1',
      name: 'echo',
      result: 'executed {"value":"x"}',
    })
    expect(events).toContainEqual({ type: 'assistant_text', delta: 'done' })
    expect(events).toContainEqual({ type: 'turn_end', stopReason: 'end_turn' })
    expect(echoTool.execute).toHaveBeenCalledTimes(1)
  })

  it('does not execute a tool when its arguments are malformed', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createSseResponse(
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call-invalid',
                  function: { name: 'echo', arguments: '{invalid' },
                }],
              },
            }],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ),
      )
      .mockResolvedValueOnce(
        createSseResponse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const echoTool: AgentTool = {
      name: 'echo',
      description: 'Echo a value',
      parameters: { type: 'object' },
      execute: vi.fn(async () => 'should not run'),
    }

    const events = await collectEvents(runAgent(model, { messages: [] }, [echoTool]))

    expect(echoTool.execute).not.toHaveBeenCalled()
    expect(events).toContainEqual({
      type: 'tool_result',
      id: 'call-invalid',
      name: 'echo',
      result: 'Error: Invalid JSON in tool call arguments',
    })
  })
})

describe('session persistence', () => {
  it('persists different files independently without duplicate messages', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'mini-pi-session-'))
    const firstSessionFile = join(tempDirectory, 'a.jsonl')
    const secondSessionFile = join(tempDirectory, 'b.jsonl')
    const firstMessage = { role: 'user' as const, content: 'first' }
    const secondMessage = { role: 'assistant' as const, content: 'second' }

    try {
      await persistSession([firstMessage], firstSessionFile)
      await persistSession([firstMessage], secondSessionFile)
      expect(await loadSession(firstSessionFile)).toEqual([firstMessage])
      expect(await loadSession(secondSessionFile)).toEqual([firstMessage])

      await persistSession([firstMessage, secondMessage], firstSessionFile)
      await persistSession([firstMessage, secondMessage], secondSessionFile)

      expect((await readFile(firstSessionFile, 'utf8')).trim().split('\n')).toHaveLength(2)
      expect((await readFile(secondSessionFile, 'utf8')).trim().split('\n')).toHaveLength(2)
    } finally {
      await rm(tempDirectory, { recursive: true, force: true })
    }
  })

  it('replaces persisted messages after context compaction', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'mini-pi-session-'))
    const sessionFile = join(tempDirectory, 'session.jsonl')
    const originalMessages = [
      { role: 'user' as const, content: 'old user message' },
      { role: 'assistant' as const, content: 'old assistant message' },
    ]
    const compactedMessages = [{ role: 'user' as const, content: '[context summary]\nsummary' }]

    try {
      await persistSession(originalMessages, sessionFile)
      await persistSession(compactedMessages, sessionFile)

      expect(await loadSession(sessionFile)).toEqual(compactedMessages)
      expect((await readFile(sessionFile, 'utf8')).trim().split('\n')).toHaveLength(1)
    } finally {
      await rm(tempDirectory, { recursive: true, force: true })
    }
  })

  it('archives the current session when starting a new one', async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), 'mini-pi-session-'))
    const sessionFile = join(tempDirectory, 'session.jsonl')
    const previousMessages = [{ role: 'user' as const, content: 'previous' }]
    const newMessages = [{ role: 'user' as const, content: 'new' }]

    try {
      await persistSession(previousMessages, sessionFile)
      const archivedSessionFile = await startNewSession(sessionFile)

      expect(archivedSessionFile).not.toBeNull()
      expect(await loadSession(archivedSessionFile!)).toEqual(previousMessages)
      expect(await loadSession(sessionFile)).toEqual([])

      await persistSession(newMessages, sessionFile)
      expect(await loadSession(sessionFile)).toEqual(newMessages)
    } finally {
      await rm(tempDirectory, { recursive: true, force: true })
    }
  })
})

describe('built-in tools', () => {
  it('keeps shell execution disabled unless explicitly enabled', () => {
    expect(builtInTools().map(tool => tool.name)).toEqual(['readFile', 'writeFile', 'edit'])
    expect(builtInTools({ enableShell: true }).map(tool => tool.name)).toContain('runBash')
  })

  it('writes inside the workspace and reports UTF-8 bytes', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'mini-pi-tools-'))
    const writeFileTool = builtInTools({ workspaceRoot }).find(tool => tool.name === 'writeFile')!

    try {
      const result = await writeFileTool.execute({ path: 'nested/output.txt', content: '你好' })

      expect(await readFile(join(workspaceRoot, 'nested/output.txt'), 'utf8')).toBe('你好')
      expect(result).toContain('Wrote 6 bytes')
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('rejects paths outside the workspace and protected files', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'mini-pi-tools-'))
    const writeFileTool = builtInTools({ workspaceRoot }).find(tool => tool.name === 'writeFile')!

    try {
      await expect(writeFileTool.execute({ path: '../outside.txt', content: 'blocked' }))
        .rejects.toThrow('outside workspace')
      await expect(writeFileTool.execute({ path: '.env', content: 'blocked' }))
        .rejects.toThrow('Path is protected')
      await expect(writeFileTool.execute({ path: '.git/config', content: 'blocked' }))
        .rejects.toThrow('Path is protected')
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})
