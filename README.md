# mini-pi

A small TypeScript coding agent built from scratch.
一个从零实现的 TypeScript 编码助手。

> Status / 状态: experimental — APIs and behavior may change before the first stable release.

## Features / 功能

- Stream assistant responses from an OpenAI-compatible chat-completions API.
- 通过兼容 OpenAI Chat Completions 协议的接口流式接收模型回复。
- Execute tool calls in a multi-step agent loop.
- 支持多轮 Agent 工具调用。
- Persist the active conversation as JSONL under `~/.minipi/session.jsonl`.
- 当前会话以 JSONL 形式保存到 `~/.minipi/session.jsonl`。
- Enter `/new` to archive the current conversation and start a fresh session.
- 输入 `/new` 可归档当前会话并立即开始新会话。
- Workspace-scoped tools for reading, writing, and editing files; optional local shell execution.
- 内置限定在工作区内的文件读写与编辑工具，并可选择启用本地 Shell 命令。

## Requirements / 环境要求

- Node.js 22 or later / Node.js 22 或更高版本
- npm
- An API key for an OpenAI-compatible provider / 兼容 OpenAI 协议的模型服务 API Key

## Quick start / 快速开始

### 1. Clone and install / 克隆并安装

```powershell
git clone https://github.com/<your-account>/mini-pi.git
cd mini-pi
npm ci
```

`npm ci` uses `package-lock.json` to install the locked dependency tree.
`npm ci` 会根据 `package-lock.json` 安装锁定版本的依赖。

### 2. Configure the environment / 配置环境变量

```powershell
Copy-Item .env.example .env
```

Open `.env` and fill in your provider settings. / 打开 `.env` 并填写模型服务配置：

```text
MINIPI_API_KEY=replace-with-your-api-key
MINIPI_BASE_URL=https://api.openai.com/v1
MINIPI_MODEL=your-model
MINIPI_ENABLE_SHELL=false
```

For DeepSeek, use the following base URL and model name. / 如果使用 DeepSeek：

```text
MINIPI_BASE_URL=https://api.deepseek.com/v1
MINIPI_MODEL=deepseek-chat
```

Never commit `.env` or a real API key. / 不要提交 `.env` 或真实 API Key。

The API key must use `MINIPI_API_KEY`. The legacy `NANOPI_BASE_URL` and `NANOPI_MODEL` names remain supported for existing local configurations.
API Key 必须使用 `MINIPI_API_KEY`。旧版 `NANOPI_BASE_URL` 和 `NANOPI_MODEL` 仍然兼容，现有本地配置可以逐步迁移。

### 3. Run / 启动

Run the development version with `.env`. / 使用 `.env` 启动开发版：

```powershell
node --env-file=.env --import tsx src/cli.ts
```

Alternatively, set the variables in your shell and run `npm run dev`.
也可以直接在终端设置环境变量后运行 `npm run dev`。

Type a prompt and press Enter. Press Ctrl+C to abort the current model request.
输入问题并按 Enter；按 Ctrl+C 可以中止当前模型请求。

Enter `/new` to archive the current session as `session-<timestamp>.jsonl` and start with an empty context.
输入 `/new` 后，当前会话会保存为 `session-<timestamp>.jsonl`，并使用空上下文开始新会话。

## Build and run / 构建并运行

```powershell
npm run build
npm start
```

## Development scripts / 开发命令

| Command | Description | 说明 |
| --- | --- | --- |
| `npm run dev` | Run the TypeScript entrypoint with `tsx`. | 使用 `tsx` 运行 TypeScript 入口。 |
| `npm run build` | Compile TypeScript into `dist/`. | 将 TypeScript 编译到 `dist/`。 |
| `npm start` | Run the compiled CLI with `.env`. | 使用 `.env` 运行编译后的 CLI。 |
| `npm run typecheck` | Type-check without emitting files. | 只做类型检查，不生成文件。 |
| `npm test` | Run the Vitest test suite. | 运行 Vitest 测试。 |

GitHub Actions runs install, type-check, test, and build checks for pushes and pull requests.
GitHub Actions 会在推送和 Pull Request 时自动执行安装、类型检查、测试与构建。

## Project structure / 项目结构

```text
src/
├─ agent.ts   # Agent loop and tool orchestration / Agent 循环与工具编排
├─ cli.ts     # CLI entrypoint and session persistence / CLI 入口与会话持久化
├─ llm.ts     # Message types and streaming adapter / 消息类型与流式适配器
├─ tools.ts   # Workspace file tools and optional shell tool / 工作区文件工具与可选 Shell 工具
└─ tui.ts     # Terminal input and output / 终端输入输出
test/
└─ core.test.ts
```

## Safety notes / 安全说明

This project is experimental. File tools are restricted to the current workspace and block common sensitive paths. Shell execution is disabled by default; set `MINIPI_ENABLE_SHELL=true` only when you accept the additional risk.
本项目仍处于实验阶段。文件工具仅能访问当前工作区，并会阻止常见敏感路径。Shell 命令默认禁用；只有在接受额外风险时才设置 `MINIPI_ENABLE_SHELL=true`。

Enabling shell execution is not an operating-system sandbox. Run the project only in a disposable or trusted workspace.
启用 Shell 命令并不等同于操作系统级沙箱，请仅在可丢弃或可信工作区中运行。

## Publishing to GitHub / 发布到 GitHub

### First publication / 首次发布

1. Create an empty repository on GitHub without initializing another README or `.gitignore`.
2. 在 GitHub 创建空仓库，建议不要再次初始化 README 或 `.gitignore`。
3. From the project directory, run the following commands. / 在项目目录执行以下命令：

```powershell
git init
git add .
git status
git commit -m 'chore: initial project'
git branch -M main
git remote add origin https://github.com/<your-account>/mini-pi.git
git push -u origin main
```

Review `git status` before committing and confirm that `.env` is not staged.
提交前请检查 `git status`，确认 `.env` 没有被加入暂存区。

### How users run it after cloning / 用户克隆后的使用方式

```powershell
git clone https://github.com/<your-account>/mini-pi.git
cd mini-pi
npm ci
Copy-Item .env.example .env
# Edit .env and add an API key
node --env-file=.env --import tsx src/cli.ts
```

GitHub repository visibility is controlled by GitHub. The `private` field in `package.json` only prevents accidental npm publication; it does not make a GitHub repository private.
GitHub 仓库的公开/私有由 GitHub 设置决定。`package.json` 中的 `private` 只用于阻止误发布到 npm，不会影响 GitHub 仓库的可见性。

## License / 许可证

The project uses the MIT License. See [LICENSE](LICENSE) for the full text.
项目使用 MIT 许可证，完整条款请查看 [LICENSE](LICENSE)。
