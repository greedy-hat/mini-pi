// Provides workspace-scoped filesystem tools and an optional local shell tool.

import { exec } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'

import type { AgentTool } from './agent.js'

const execAsync = promisify(exec)
const MAX_OUTPUT_LINES = 200
const PROTECTED_DIRECTORY_NAMES = new Set(['.git', '.omx', 'node_modules'])

let truncationFileCounter = 0

export type BuiltInToolsOptions = {
  workspaceRoot?: string
  enableShell?: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool arguments must be a JSON object')
  }
  return value as Record<string, unknown>
}

function requiredString(argumentsObject: Record<string, unknown>, name: string): string {
  const value = argumentsObject[name]
  if (typeof value !== 'string') {
    throw new Error(`Argument "${name}" must be a string`)
  }
  return value
}

function isInside(rootPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(rootPath, candidatePath)
  return relativePath === '' || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath))
}

function assertUnprotectedPath(workspaceRoot: string, candidatePath: string): void {
  const relativeParts = path.relative(workspaceRoot, candidatePath).split(path.sep)
  for (const part of relativeParts) {
    const normalizedPart = part.toLowerCase()
    if (PROTECTED_DIRECTORY_NAMES.has(normalizedPart)) {
      throw new Error(`Path is protected: ${candidatePath}`)
    }
    if (normalizedPart === '.env' || (normalizedPart.startsWith('.env.') && normalizedPart !== '.env.example')) {
      throw new Error(`Path is protected: ${candidatePath}`)
    }
  }
}

async function nearestExistingPath(candidatePath: string): Promise<string> {
  let currentPath = candidatePath
  while (true) {
    try {
      await fs.lstat(currentPath)
      return currentPath
    } catch (error: unknown) {
      const errorCode = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      if (errorCode !== 'ENOENT') throw error
      const parentPath = path.dirname(currentPath)
      if (parentPath === currentPath) throw error
      currentPath = parentPath
    }
  }
}

async function resolveWorkspacePath(workspaceRoot: string, requestedPath: string): Promise<string> {
  if (!requestedPath.trim()) throw new Error('Path must not be empty')

  const candidatePath = path.resolve(workspaceRoot, requestedPath)
  if (!isInside(workspaceRoot, candidatePath)) {
    throw new Error(`Path is outside workspace: ${requestedPath}`)
  }
  assertUnprotectedPath(workspaceRoot, candidatePath)

  const [realWorkspaceRoot, existingPath] = await Promise.all([
    fs.realpath(workspaceRoot),
    nearestExistingPath(candidatePath),
  ])
  const realExistingPath = await fs.realpath(existingPath)
  if (!isInside(realWorkspaceRoot, realExistingPath)) {
    throw new Error(`Path resolves outside workspace: ${requestedPath}`)
  }
  return candidatePath
}

async function truncateOutput(content: string, maxLines = MAX_OUTPUT_LINES): Promise<string> {
  const outputLines = content.split('\n')
  if (outputLines.length <= maxLines) return content
  const keptLines = outputLines.slice(-maxLines).join('\n')
  const outputFilePath = path.join(os.tmpdir(), `mini-pi-output-${process.pid}-${truncationFileCounter++}.txt`)
  await fs.writeFile(outputFilePath, content, 'utf-8')
  return `[output truncated: showing last ${maxLines} of ${outputLines.length} lines. full output: ${outputFilePath}]\n${keptLines}`
}

function createReadFileTool(workspaceRoot: string): AgentTool {
  return {
    name: 'readFile',
    description: 'Read a UTF-8 file inside the current workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'A path inside the workspace.' } },
      required: ['path'],
      additionalProperties: false,
    },
    execute: async (toolArguments) => {
      const requestedPath = requiredString(asRecord(toolArguments), 'path')
      const filePath = await resolveWorkspacePath(workspaceRoot, requestedPath)
      return truncateOutput(await fs.readFile(filePath, 'utf-8'))
    },
  }
}

function createWriteFileTool(workspaceRoot: string): AgentTool {
  return {
    name: 'writeFile',
    description: 'Create or overwrite a UTF-8 file inside the current workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'A path inside the workspace.' },
        content: { type: 'string', description: 'The complete file content.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    execute: async (toolArguments) => {
      const argumentsObject = asRecord(toolArguments)
      const requestedPath = requiredString(argumentsObject, 'path')
      const fileContent = requiredString(argumentsObject, 'content')
      const filePath = await resolveWorkspacePath(workspaceRoot, requestedPath)
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, fileContent, 'utf-8')
      return `Wrote ${Buffer.byteLength(fileContent, 'utf8')} bytes to ${filePath}`
    },
  }
}

function createEditTool(workspaceRoot: string): AgentTool {
  return {
    name: 'edit',
    description: 'Replace exactly one text occurrence in a UTF-8 workspace file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'A path inside the workspace.' },
        old_string: { type: 'string', description: 'The exact text to replace.' },
        new_string: { type: 'string', description: 'The replacement text.' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    execute: async (toolArguments) => {
      const argumentsObject = asRecord(toolArguments)
      const requestedPath = requiredString(argumentsObject, 'path')
      const oldText = requiredString(argumentsObject, 'old_string')
      const newText = requiredString(argumentsObject, 'new_string')
      if (!oldText) throw new Error('Argument "old_string" must not be empty')

      const filePath = await resolveWorkspacePath(workspaceRoot, requestedPath)
      const fileContent = await fs.readFile(filePath, 'utf-8')
      const occurrenceCount = fileContent.split(oldText).length - 1
      if (occurrenceCount === 0) throw new Error(`String "${oldText}" not found in file ${filePath}`)
      if (occurrenceCount > 1) {
        throw new Error(`String "${oldText}" found ${occurrenceCount} times in file ${filePath}. Please make it unique.`)
      }
      await fs.writeFile(filePath, fileContent.replace(oldText, () => newText), 'utf-8')
      return `Replaced one occurrence of "${oldText}" in ${filePath}`
    },
  }
}

function createRunBashTool(workspaceRoot: string): AgentTool {
  return {
    name: 'runBash',
    description: 'Run a local shell command with the current workspace as its working directory.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The shell command to run.' } },
      required: ['command'],
      additionalProperties: false,
    },
    execute: async (toolArguments, signal) => {
      const command = requiredString(asRecord(toolArguments), 'command')
      if (!command.trim()) throw new Error('Argument "command" must not be empty')
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: workspaceRoot,
          maxBuffer: 1024 * 1024,
          timeout: 10000,
          signal,
        })
        return truncateOutput(stderr ? `STDERR:\n${stderr}\nSTDOUT:\n${stdout}` : stdout)
      } catch (error: unknown) {
        if (error && typeof error === 'object' && 'killed' in error && error.killed) {
          throw new Error(`Command "${command}" was killed (timeout or signal)`)
        }
        throw new Error(`Command "${command}" failed: ${errorMessage(error)}`)
      }
    },
  }
}

/** Return workspace file tools, plus shell access only when explicitly enabled. */
export function builtInTools(options: BuiltInToolsOptions = {}): AgentTool[] {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd())
  const tools = [
    createReadFileTool(workspaceRoot),
    createWriteFileTool(workspaceRoot),
    createEditTool(workspaceRoot),
  ]
  if (options.enableShell) tools.push(createRunBashTool(workspaceRoot))
  return tools
}
