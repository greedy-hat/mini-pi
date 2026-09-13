import * as readline from 'node:readline'
 
export class Tui {
  private readlineInterface: readline.Interface | null = null
  private promptHandler: ((promptText: string) => void) | null = null
  private abortHandler: (() => void) | null = null
  private isAborted = false
  private isBusy = false // True while the agent is running; prevents concurrent input.

  /** Register the prompt callback. */
  onPrompt(handler: (promptText: string) => void): void {
    this.promptHandler = handler
  }

  /** Register the Ctrl+C callback. */
  onAbort(handler: () => void): void {
    this.abortHandler = handler
  }
 
  /** Start the TUI and begin reading input. */
  start(): void {
    this.readlineInterface = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    process.stdin.on(
      'keypress',
      (_character: string, keyInfo: { ctrl?: boolean; name?: string } | undefined) => {
        // Handle Ctrl+C only while the agent is running; let readline handle it while idle.
        if (this.isBusy && keyInfo?.ctrl && keyInfo?.name === 'c' && !this.isAborted) {
          this.isAborted = true
          this.abortHandler?.()
        }
      },
    )
 
    this.prompt()
  }

  private prompt(): void {
    if (!this.readlineInterface) return
    if (this.isBusy) return // Do not show a prompt while the agent is running.
    this.isAborted = false
    this.readlineInterface.question('> ', (inputLine) => {
      const promptText = inputLine.trim()
      if (promptText) {
        this.promptHandler?.(promptText)
        // Do not prompt recursively; setBusy(false) will resume input.
      } else {
        this.prompt() // Reprompt for empty input without invoking the callback.
      }
    })
  }
 
  /** Mark whether the agent is running and block or resume input accordingly. */
  setBusy(isBusy: boolean): void {
    this.isBusy = isBusy
    if (!isBusy) this.prompt() // Resume input when the agent finishes.
  }
 
  /** Print a streamed assistant text delta. */
  printText(delta: string): void {
    process.stdout.write(delta)
  }
 
  /** Print a tool call. */
  printToolCall(toolName: string, toolArguments: unknown): void {
    process.stdout.write(`\n[tool: ${toolName}] ${JSON.stringify(toolArguments)}\n`)
  }
 
  /** Print a tool result. */
  printToolResult(toolName: string, toolResult: string): void {
    process.stdout.write(`[result: ${toolName}] ${toolResult}\n`)
  }
 
  /** Print the end of a turn. */
  printTurnEnd(): void {
    process.stdout.write('\n')
  }
 
  /** Stop the TUI and clean up listeners. */
  stop(): void {
    this.readlineInterface?.close()
    this.readlineInterface = null
    process.stdin.removeAllListeners('keypress')
  }
}
 
