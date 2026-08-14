# dsh-codex-canvas

DeepSeek Harness 工具插件：通过 Codex CLI 调度 gpt-image-2 生图。

在 harness 组合中注册一个模型可见的 `image_gen` 工具。调用时 spawn `codex exec`
（走 harness 的 `ctx.subprocess` seam，受统一的进程生命周期管理），默认以后台 job
运行（`ctx.jobs`），模型用标准 `job_output` / `job_kill` 收集或终止；生成的 PNG
落在会话工作区的 `images/` 下。

## 前置条件（运行 harness 的机器上）

```sh
npm i -g @openai/codex
codex login        # 浏览器 ChatGPT 账号授权；不需要 OpenAI API key
codex login status # 应显示 Logged in using ChatGPT
```

## 安装（用户视角）

方式一：从 git 安装（推荐锁 commit）：

```sh
dsh plugin --profile demo add github:you/dsh-codex-canvas#<sha>
```

git 安装会在安装时运行 `prepare` 构建脚本，pnpm ≥10 需要授权——按提示把包键加入
profile 的 `pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-codex-canvas: true
```

方式二：npm / tarball（预构建，无需授权）：

```sh
dsh plugin --profile demo add dsh-codex-canvas
# 或
pnpm pack && dsh plugin --profile demo add ./dsh-codex-canvas-0.1.0.tgz
```

启动：

```sh
dsh --profile demo            # 或源码 checkout 内：pnpm dsh --profile demo
dsh --profile demo --dump-config  # 应看到 "# == dsh-codex-canvas" 层
```

## 本地开发（源码 checkout 内）

```sh
pnpm dsh plugin --profile demo add ./dsh-codex-canvas
pnpm dsh web --profile demo
# 浏览器打开 http://127.0.0.1:3080，对模型说：
# "Use image_gen to draw a shiba in sunglasses, save as shiba.png"
```

## 配置

在 profile 的 `cordis.patch.yml` 里按 `id: codex-canvas` 覆盖（需重述整行）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `codexBinary` | `codex` | codex 可执行文件（PATH 名或绝对路径） |
| `timeoutMs` | `300000` | 前台调用的生成时限 |
| `graceMs` | `5000` | 进程树终止升级的宽限期 |

## 工具 schema（模型可见）

`image_gen(prompt: string, file_name: string, run_in_background?: boolean)`

- 默认 `run_in_background: true` → 返回 `{ kind: 'background', jobId }`
- `false` → 同步等待，返回 `{ kind: 'foreground', status: 'ok', path, bytes }` 或错误信息
- 产物路径：`<会话工作区>/images/<file_name>`

## 设计说明

- 进程走 `ctx.subprocess` seam：环境自动洗掉 credential 形状变量与 `DSH_*`，
  终止按 SIGTERM→宽限→SIGKILL 全树升级，不直接用 `child_process`
- 后台 job 发布 id 后生命周期归 `job_kill` / owner dispose / 服务 teardown
- job kind `image-gen` 通过 `declare module '@deepseek-ai/dsh-jobs'` 扩展
  `JobKindMap`（与官方 `tool-pwsh` 同一模式）
