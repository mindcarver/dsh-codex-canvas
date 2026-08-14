# dsh-codex-canvas

[中文](#中文) | [English](#english)

<a id="english"></a>

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that gives the agent an `image_gen` tool backed by the **Codex CLI** (gpt-image-2). Say "draw me a shiba in sunglasses" in the Web UI and the harness spawns `codex exec` to generate the image — no OpenAI API key needed, a logged-in ChatGPT account is enough.

## How it works

```
agent ──▶ image_gen(prompt, file_name)          (model-facing tool)
              │
              ├── ctx.subprocess ──▶ codex exec -C <workspace> -s workspace-write ...
              │                          └─ gpt-image-2 ──▶ <workspace>/images/<file_name>
              └── ctx.jobs (background by default) ──▶ collect with job_output / job_kill
```

- Processes go through the harness `ctx.subprocess` seam: credential-shaped env vars are scrubbed, termination escalates SIGTERM → grace → SIGKILL across the whole process tree.
- Generation takes ~1 minute, so the tool defaults to `run_in_background: true` and returns a job id; the model collects the result with the standard `job_output` tool.
- Output lands in the session workspace under `images/`.

## Prerequisites (once per machine)

```sh
npm i -g @openai/codex
codex login          # browser ChatGPT sign-in; no OpenAI API key required
codex login status   # should print "Logged in using ChatGPT"
```

Windows note: if you see `failed to spawn code-mode-host`, your codex install is broken — reinstall with `npm i -g @openai/codex`.

## Install

```sh
npx @deepseek-ai/dsh plugin --profile web add github:mindcarver/dsh-codex-canvas#<sha>
```

Git installs run the `prepare` build script; pnpm ≥10 asks you to authorize it — copy the package key it prints into the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-codex-canvas: true
```

then re-run the `add`. Prefer no build authorization? Install the pre-built tarball instead:

```sh
npx @deepseek-ai/dsh plugin --profile web add ./dsh-codex-canvas-0.1.0.tgz
```

## Use

Start the Web UI (profile `web` is the default for `dsh web`):

```sh
npx @deepseek-ai/dsh web      # http://127.0.0.1:3080
```

Then just ask the agent:

> 用 image_gen 画一只戴墨镜的柴犬，存成 shiba.png

### Tool schema (model-visible)

`image_gen(prompt: string, file_name: string, run_in_background?: boolean)`

| Param | Default | Notes |
| --- | --- | --- |
| `prompt` | — | Natural-language description; be specific about style and composition |
| `file_name` | — | Relative name, e.g. `hero.png` or `icons/logo.png` → `images/<file_name>` in the workspace |
| `run_in_background` | `true` | `true` returns `{kind: 'background', jobId}` (collect via `job_output`); `false` waits and returns `{status: 'ok', path, bytes}` |

## Configuration

Override the plugin row (`id: codex-canvas`) in the profile's `cordis.patch.yml` (restate the full row):

```yaml
- id: codex-canvas
  name: dsh-codex-canvas
  config:
    codexBinary: codex      # executable (PATH name or absolute path)
    timeoutMs: 300000       # foreground generation budget
    graceMs: 5000           # process-tree terminate grace
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `codex` not found | `npm i -g @openai/codex`, check `codex --version` |
| Not logged in | `codex login` |
| Image lands in wrong place | The plugin always passes `-C <session workspace>`; check the job output for the actual path |
| Generation takes > 5 min and gets killed | Raise `timeoutMs` |

## Development

```sh
git clone https://github.com/mindcarver/dsh-codex-canvas
cd dsh-codex-canvas
npm install
npx tsdown            # build to lib/
npx tsc --noEmit      # typecheck
pnpm pack             # release tarball
```

To load during development without a profile install, see the harness [first-plugin tutorial](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/index.zh.md) (`--patch` overlay). **Never** run `dsh plugin add` from an un-built source checkout of the harness itself — profile symlinks heal toward the running dsh installation.

---

<a id="中文"></a>

# dsh-codex-canvas（中文说明）

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：给 agent 注册一个 `image_gen` 工具，底层通过 **Codex CLI**（gpt-image-2）生图。在 Web UI 里说"画一只戴墨镜的柴犬"，harness 就会 spawn `codex exec` 生成图片——不需要 OpenAI API key，ChatGPT 账号登录一次即可。

## 前置条件（每台机器一次）

```sh
npm i -g @openai/codex
codex login          # 浏览器 ChatGPT 授权，无需 API key
codex login status   # 应显示 Logged in using ChatGPT
```

Windows 提示：如果报 `failed to spawn code-mode-host`，说明 codex 安装损坏，`npm i -g @openai/codex` 重装即可。

## 安装

```sh
npx @deepseek-ai/dsh plugin --profile web add github:mindcarver/dsh-codex-canvas#<sha>
```

git 安装会运行 `prepare` 构建脚本，pnpm ≥10 需授权——按提示把包键加进 profile 的 `pnpm-workspace.yaml` 后重新 `add`：

```yaml
allowBuilds:
  dsh-codex-canvas: true
```

不想授权构建就用预构建 tarball：`npx @deepseek-ai/dsh plugin --profile web add ./dsh-codex-canvas-0.1.0.tgz`

## 使用

```sh
npx @deepseek-ai/dsh web     # 打开 http://127.0.0.1:3080
```

对模型说：**"用 image_gen 画一只戴墨镜的柴犬，存成 shiba.png"**

- 默认后台运行：立即返回 jobId，约 1 分钟后模型用 `job_output` 收结果
- `run_in_background: false` 则同步等待
- 图片落在会话工作区 `images/<file_name>`

## 配置（可选）

在 profile 的 `cordis.patch.yml` 覆盖 `id: codex-canvas` 行（需重述整行）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `codexBinary` | `codex` | codex 可执行文件（PATH 名或绝对路径） |
| `timeoutMs` | `300000` | 前台调用时限 |
| `graceMs` | `5000` | 进程树终止宽限 |

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 找不到 codex | `npm i -g @openai/codex` |
| 未登录 | `codex login` |
| 超时被杀 | 调大 `timeoutMs` |

## 已知坑（重要）

**不要从"未构建的 harness 源码 checkout"里跑 `dsh plugin add`**——profile 的共享符号链接会向当前 dsh 安装"自愈"，未构建源码没有 `lib/`，会把你的全局 npx 环境搞坏。从源码跑 harness 必须先 `pnpm install && pnpm run build`。
