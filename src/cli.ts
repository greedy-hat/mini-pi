#!/usr/bin/env node

// Session persistence: rewrite ~/.minipi/session.jsonl after each turn.
 
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { pathToFileURL } from 'node:url'
import { runAgent } from './agent.js'
import { Tui } from './tui.js'
import { builtInTools } from './tools.js'
import type { Context, Message, Model } from './llm.js'
 
const SESSION_DIR = path.join(os.homedir(), '.minipi')
const SESSION_FILE = path.join(SESSION_DIR, 'session.jsonl')
const NEW_SESSION_COMMAND = '/new'
 
/** System prompt used for every session. */
const SYSTEM_PROMPT = 'You are a coding assistant. Use the provided tools to read and write files and run commands to complete tasks. Read before editing, and run commands to verify your changes.'
 
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function environmentValue(primaryName: string, legacyName: string): string | undefined {
  return process.env[primaryName] ?? process.env[legacyName]
}

function isFileNotFoundError(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

async function getAvailableArchivePath(sessionDirectory: string): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const archiveBaseName = `session-${timestamp}`

  for (let suffix = 0; ; suffix += 1) {
    const suffixText = suffix === 0 ? '' : `-${suffix}`
    const archivePath = path.join(sessionDirectory, `${archiveBaseName}${suffixText}.jsonl`)

    try {
      await fs.access(archivePath)
    } catch (error: unknown) {
      if (isFileNotFoundError(error)) return archivePath
      throw error
    }
  }
}
 
async function main(): Promise<void> {
  const apiKey = process.env.MINIPI_API_KEY
  if (!apiKey) {
    console.error('Please set the MINIPI_API_KEY environment variable.')
    process.exit(1)
  }

  const modelConfig: Model = {
    apiKey,
    model: environmentValue('MINIPI_MODEL', 'NANOPI_MODEL') ?? 'glm-5.2',
    baseUrl: environmentValue('MINIPI_BASE_URL', 'NANOPI_BASE_URL') ?? 'https://api.openai.com/v1',
    maxTokens: 4096,
  }
 
  // Initialize the context with a dedicated system prompt and messages loaded from the session file.
  const context: Context = {
    systemPrompt: SYSTEM_PROMPT,
    messages: await loadSession(),
  }
 
  const enableShell = process.env.MINIPI_ENABLE_SHELL === 'true'
  const availableTools = builtInTools({ workspaceRoot: process.cwd(), enableShell })
  const tui = new Tui()
 
  // Each turn: receive user input, run the agent, forward events to the TUI, and persist the session.
  tui.onPrompt(async (promptText) => {
    tui.setBusy(true)
    try {
      if (promptText === NEW_SESSION_COMMAND) {
        if (context.messages.length > 0) {
          await persistSession(context.messages)
        }

        const archivedSessionFile = await startNewSession()
        context.messages.length = 0
        if (archivedSessionFile) {
          tui.printText(`\n[new session started; archived ${path.basename(archivedSessionFile)}]\n`)
        } else {
          tui.printText('\n[new session started]\n')
        }
        return
      }

      context.messages.push({ role: 'user', content: promptText })

      const abortController = new AbortController()
      // Create a new AbortController for each turn and register the abort callback for it.
      tui.onAbort(() => abortController.abort())

      for await (const event of runAgent(modelConfig, context, availableTools, abortController.signal)) {
        switch (event.type) {
          case 'assistant_text':
            tui.printText(event.delta)
            break
          case 'tool_call':
            tui.printToolCall(event.name, event.args)
            break
          case 'tool_result':
            tui.printToolResult(event.name, event.result)
            break
          case 'turn_end':
            if (event.stopReason === 'max_tokens') {
              tui.printText('\n[output truncated by max_tokens]')
            }
            if (event.stopReason === 'error') {
              tui.printText('\n[error occurred]')
            }
            tui.printTurnEnd()
            break
        }
      }
 
      await persistSession(context.messages)
    } catch (error: unknown) {
      console.error(`\n[error] ${errorMessage(error)}`)
    } finally {
      tui.setBusy(false)
    }
  })
 
  tui.start()
 
}
 
/** Load historical messages at startup to restore the previous conversation. */
export async function loadSession(sessionFile: string = SESSION_FILE): Promise<Message[]> {
  const sessionPath = path.resolve(sessionFile)

  try {
    const sessionData = await fs.readFile(sessionPath, 'utf-8')
    const sessionLines = sessionData.split(/\r?\n/).filter(sessionLine => sessionLine.trim())
    // Skip malformed lines instead of discarding the entire history; a crash may leave a partial JSON line.
    const sessionMessages = sessionLines.flatMap(sessionLine => {
      try {
        return [JSON.parse(sessionLine) as Message]
      } catch {
        return []
      }
    })
    return sessionMessages
  } catch (error: unknown) {
    if (!isFileNotFoundError(error)) throw error

    return [] // The file does not exist; start with an empty session.
  }
}
 
/** Persist messages to the session file. */
export async function persistSession(
  messages: Message[],
  sessionFile: string = SESSION_FILE,
): Promise<void> {
  const sessionPath = path.resolve(sessionFile)
  await fs.mkdir(path.dirname(sessionPath), { recursive: true })
  const sessionData = messages.map(message => JSON.stringify(message)).join('\n')
  await fs.writeFile(sessionPath, sessionData ? `${sessionData}\n` : '', 'utf-8')
}

/** Archive the current session file and reset it for a new conversation. */
export async function startNewSession(sessionFile: string = SESSION_FILE): Promise<string | null> {
  const sessionPath = path.resolve(sessionFile)
  const sessionDirectory = path.dirname(sessionPath)
  await fs.mkdir(sessionDirectory, { recursive: true })

  let sessionSize = 0
  try {
    sessionSize = (await fs.stat(sessionPath)).size
  } catch (error: unknown) {
    if (!isFileNotFoundError(error)) throw error
  }

  if (sessionSize === 0) {
    return null
  }

  const archivedSessionFile = await getAvailableArchivePath(sessionDirectory)
  await fs.rename(sessionPath, archivedSessionFile)
  return archivedSessionFile
}
 
// Start only when this module is executed directly, not when it is imported.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(errorMessage(error))
    process.exit(1)
  })
}
 
