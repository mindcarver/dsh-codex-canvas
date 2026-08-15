# dsh-codex-canvas

DeepSeek Harness 工具插件：通过 Codex CLI 调度 gpt-image-2 生图，生成结果直接在 Web 工具卡内回显。

在 harness 组合中注册一个模型可见的 `image_gen` 工具。调用时 spawn `codex exec`
（走 harness 的 `ctx.subprocess` seam，受统一的进程生命周期管理），默认以后台 job
运行（`ctx.jobs`），模型用标准 `job_output` / `job_kill` 收集或终止；生成的 PNG
落在会话工作区的 `images/` 下，模型可见历史保持纯文本。

## Web 内联回显

同一 npm 包提供双端入口：Node 半边（`exports["."]`）注册工具与 `/codex-canvas`
RPC 通道；浏览器半边（`exports["./client"]`，`dsh.client.platform: web`）注册
`image_gen` 的专属工具卡（`tool.call.toolview` keyed 槽）。

- 工具结果通过 `output.presentationMeta` 持久化 UI 专用产物描述符（只含引用，
  不含图片字节，不进入模型上下文），页面刷新或 DSH 重启后按会话日志回放。
- 后台生成期间卡片显示"生成中"，完成后自动经 RPC 拉取图片内联回显，支持点击
  放大/关闭（Esc/点击背景），无需模型额外调用。
- RPC 每次请求都从 sessionId + callId 重新校验归属（tool/call 必须是 image_gen、
  tool/result 必须携带本插件描述符、artifactId 必须一致），读取限制在该会话
  `images/` 目录内，拒绝路径逃逸、符号链接逃逸、非普通文件、超限与非图片文件。
- CLI/headless 组合没有 connection 服务时，RPC 不注册，工具保持纯文本行为。

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
npm install --legacy-peer-deps
npx tsdown        # 同时构建 node 半边 lib/index.js 与浏览器半边 lib/client.js
npx tsc --noEmit  # 类型检查
npm test          # 聚焦单测（meta 投影、路径安全、RPC 授权、客户端模型）
pnpm dsh plugin --profile demo add ./dsh-codex-canvas
pnpm dsh web --profile demo
# 浏览器打开 http://127.0.0.1:3080，对模型说：
# "Use image_gen to draw a shiba in sunglasses, save as shiba.png"
```

`types/*.d.ts` 为 `dsh-client-ui-tool` / `dsh-client-connection` 等发布闭环不完整的
包提供编译期结构化垫片；node 半边的 `@deepseek-ai/*` 全部保持 external，由 profile
parent-walk 在运行时解析到当前 dsh 安装。

## 配置

在 profile 的 `cordis.patch.yml` 里按 `id: codex-canvas` 覆盖（需重述整行）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `codexBinary` | `codex` | codex 可执行文件（PATH 名或绝对路径） |
| `timeoutMs` | `300000` | 前台调用的生成时限 |
| `graceMs` | `5000` | 进程树终止升级的宽限期 |
| `maxImageBytes` | `26214400` | 回显 RPC 的单图大小上限（25 MiB） |

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
