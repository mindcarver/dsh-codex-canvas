/**
 * codex-canvas: model-facing image generation tool backed by the Codex CLI
 * (gpt-image-2). Spawns `codex exec` through the `ctx.subprocess` seam and
 * registers long generations with `ctx.jobs` so the agent collects them via
 * the standard `job_output` / `job_kill` tools.
 *
 * Prerequisite on the machine running the harness: `codex` on PATH and
 * `codex login` completed once (ChatGPT account; no OpenAI API key needed).
 *
 * @module dsh-codex-canvas
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { DEFAULT_MAX_IMAGE_BYTES } from './artifact.ts'
import { createArtifactRpcHandler, RPC_CHANNEL, type ArtifactJobEntry, type ArtifactJobRegistryLike, type ArtifactJobState } from './rpc.ts'
import { artifactMetaFromValue, type MetaValue } from './shared/meta.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    'image-gen': 'image-gen'
  }
}

export const name = 'codex-canvas'
export const inject = ['tools', 'subprocess', 'jobs']

/** Configuration for the codex-canvas plugin. */
export interface Config {
  /** Executable to invoke (bare PATH name or absolute path). */
  codexBinary: string
  /** Millisecond budget for one generation (foreground deadline; background abort bound). */
  timeoutMs: number
  /** Terminate-escalation grace for the spawned process tree, milliseconds. */
  graceMs: number
  /** Extra environment entries for the codex child (e.g. HTTPS_PROXY=http://127.0.0.1:10809). */
  env: Record<string, string>
  /** Size cap for one image served through the preview RPC, bytes. */
  maxImageBytes: number
}

/** Runtime configuration schema for the codex-canvas plugin. */
export const Config: z<Config> = z.object({
  codexBinary: z.string().default('codex'),
  timeoutMs: z.number().default(300_000),
  graceMs: z.number().default(5_000),
  env: z.object({}).default({}),
  maxImageBytes: z.number().default(DEFAULT_MAX_IMAGE_BYTES),
})

const description = 'Generate an image with gpt-image-2 through the Codex CLI. '
  + 'Takes a natural-language prompt and a file name; the PNG is written into the '
  + 'session workspace under the configured output directory (default `images/`). '
  + 'Generation takes roughly a minute. By default the call runs in the background '
  + 'and returns a job id immediately — collect it with `job_output` and stop it '
  + 'with `job_kill`. Requires `codex` on PATH with `codex login` already completed.'

/** Union returned by the tool (canonical value). */
type ImageGenResult =
  | { kind: 'background'; jobId: string }
  | { kind: 'foreground'; status: 'ok'; path: string; bytes: number }
  | { kind: 'foreground'; status: 'error'; message: string }

interface ImageGenArgs {
  prompt: string
  file_name: string
  run_in_background?: boolean
}

function validateArgs(args: ImageGenArgs): void {
  if (args.prompt.trim().length === 0) {
    throw new Error('invalid prompt: expected a non-empty string')
  }
  if (args.file_name.trim().length === 0) {
    throw new Error('invalid file_name: expected a non-empty string')
  }
  if (isAbsolute(args.file_name) || args.file_name.includes('..')) {
    throw new Error('invalid file_name: expected a relative name inside the workspace (no absolute paths or ..)')
  }
}

/** Resolve the workspace-relative output directory; today it is fixed at `images/`. */
function outputDirFor(cwd: string): string {
  return resolve(cwd, 'images')
}

function buildCodexPrompt(prompt: string, outputPath: string): string {
  return 'Use the image generation tool to generate an image: '
    + `${prompt}. Save the file exactly at ${outputPath}. Do not print the image content; reply with the saved file path only.`
}

/**
 * Spawn `codex exec` for one generation through the subprocess seam.
 * `signal` (when provided) bounds the whole run; tree termination escalates
 * through the seam after `config.graceMs`.
 */
function spawnCodex(ctx: Context, config: Config, request: string, cwd: string, signal: AbortSignal): SubprocessHandle {
  return ctx.subprocess.spawn({
    argv: [
      config.codexBinary,
      'exec',
      '-C', cwd,
      '-s', 'workspace-write',
      '--skip-git-repo-check',
      request,
    ],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 64 * 1024 },
      stderr: { maxBytes: 64 * 1024 },
    },
    graceMs: config.graceMs,
    signal,
    // Explicit opt-in entries (e.g. HTTPS_PROXY) survive the seam's credential scrub;
    // undefined-valued keys are dropped so they never tombstone ambient entries.
    env: Object.fromEntries(Object.entries(config.env).filter(([, v]) => v !== undefined)),
  } satisfies SubprocessSpawnSpec)
}

/**
 * Codex's image-generation tool frequently IGNORES the requested save path and
 * drops the PNG into its own default directory `~/.codex/generated_images/`
 * under a uuid name. When the requested path is missing after a clean exit,
 * recover the freshest image this run produced (mtime after `startedAt`) and
 * move it to the requested path.
 */
async function recoverFromCodexImagesDir(outputPath: string, startedAt: number): Promise<boolean> {
  const root = join(homedir(), '.codex', 'generated_images')
  // codex nests images one level down: generated_images/<session-uuid>/<exec-uuid>.png
  let sessionDirs: string[]
  try {
    sessionDirs = await readdir(root)
  } catch {
    return false
  }
  let newest: { path: string; mtime: number } | undefined
  for (const session of sessionDirs) {
    const sessionDir = join(root, session)
    let files: string[]
    try {
      files = await readdir(sessionDir)
    } catch {
      continue
    }
    for (const name of files) {
      if (!name.toLowerCase().endsWith('.png')) continue
      const p = join(sessionDir, name)
      try {
        const info = await stat(p)
        // Only images created during THIS codex run (clock skew tolerance 5s).
        if (info.mtimeMs < startedAt - 5_000) continue
        if (newest === undefined || info.mtimeMs > newest.mtime) newest = { path: p, mtime: info.mtimeMs }
      } catch { /* raced away */ }
    }
  }
  if (newest === undefined) return false
  await mkdir(dirname(outputPath), { recursive: true })
  await copyFile(newest.path, outputPath)
  return true
}

/** Project one settled job outcome into preview-registry memory. */
function jobStateOf(outcome: JobOutcome): ArtifactJobState {
  if (outcome.status === 'completed') return { status: 'completed' }
  if (outcome.status === 'killed') return { status: 'killed' }
  return { status: 'failed', detail: outcome.detail ?? 'generation failed' }
}

/** Map a settled codex process to a job outcome; reads retained stderr tail. */
async function settleOutcome(handle: SubprocessHandle, outputPath: string, startedAt: number): Promise<JobOutcome> {
  let outcome: Awaited<SubprocessHandle['done']>
  try {
    outcome = await handle.done
  } catch (error: unknown) {
    return { status: 'failed', detail: `codex launch failed: ${String(error)}` }
  }
  if (outcome.exitCode === 0) {
    try {
      const info = await stat(outputPath)
      return { status: 'completed', output: `image written to ${outputPath} (${info.size} bytes)` }
    } catch {
      if (await recoverFromCodexImagesDir(outputPath, startedAt)) {
        const info = await stat(outputPath)
        return { status: 'completed', output: `image written to ${outputPath} (${info.size} bytes, recovered from codex generated_images)` }
      }
      const stdout = handle.collected.stdout?.readFrom(0)?.text ?? ''
      return { status: 'failed', detail: 'codex exited 0 but produced no image (network/login issue?)', output: `expected ${outputPath}; codex said: ${stdout.trim().slice(-500) || '(no output)'}` }
    }
  }
  const stderr = handle.collected.stderr?.readFrom(0)?.text ?? ''
  return {
    status: 'failed',
    detail: `codex exit code: ${outcome.exitCode ?? 'signal ' + String(outcome.signal)}`,
    output: stderr.trim().slice(-2_000) || undefined,
  }
}

export function apply(ctx: Context, config: Config): void {
  const cfg: Config = { ...Config, ...config }

  // In-process memory of background generations: the preview RPC consults it
  // to tell "still generating" from "failed/killed" before the file exists.
  const jobStates = new Map<string, ArtifactJobEntry>()
  const registry: ArtifactJobRegistryLike = { get: jobId => jobStates.get(jobId) }

  // Web preview RPC: activates only in compositions that expose the
  // connection/sessions services (the web profile); CLI/headless keeps the
  // text-only behavior with no channel registered.
  ctx.inject(['connection', 'sessions', 'sessionPersistence'], rpcCtx => {
    void rpcCtx.connection.rpc.handle(
      RPC_CHANNEL,
      createArtifactRpcHandler({
        services: { sessions: rpcCtx.sessions, sessionPersistence: rpcCtx.sessionPersistence },
        registry,
        maxImageBytes: cfg.maxImageBytes,
      }) as unknown as ConnectionRpcHandler,
      { authority: 'trusted-host' },
    )
  })

  ctx.tools.register(defineTool({
    name: 'image_gen',
    description,
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'What to draw, in natural language. Be specific about style, composition, and details.',
      },
      file_name: {
        type: 'string',
        required: true,
        description: 'Relative file name for the PNG, e.g. "hero.png" or "icons/logo.png". Resolved under images/ in the session workspace.',
      },
      run_in_background: {
        type: 'boolean',
        description: 'Default true: return a job id immediately (collect with job_output). Set false to wait synchronously for the file.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          result: {
            required: true,
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'background' },
                  jobId: { type: 'string', required: true },
                },
              },
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  kind: { type: 'string', required: true, const: 'foreground' },
                  status: { type: 'string', required: true, enum: ['ok', 'error'] },
                  path: { type: 'string' },
                  bytes: { type: 'number' },
                  message: { type: 'string' },
                },
              },
            ],
          },
        },
      },
      render: (_args: ImageGenArgs, value: { result: ImageGenResult }) => [{
        type: 'text',
        text: value.result.kind === 'background'
          ? `started background job ${value.result.jobId} — read its output with job_output`
          : value.result.status === 'ok'
            ? `image written to ${value.result.path} (${value.result.bytes} bytes)`
            : `image generation failed: ${value.result.message}`,
      }],
      presentationMeta: (args: ImageGenArgs, value: { result: ImageGenResult }) =>
        artifactMetaFromValue(args, value.result as MetaValue),
    },
    presentCall(args: ImageGenArgs) {
      return {
        card: 'terminal',
        title: `${cfg.codexBinary} exec (image generation)`,
        description: `generate ${args.file_name}`,
      }
    },
    async execute(args: ImageGenArgs, exec: ToolExecution) {
      validateArgs(args)
      const cwd = exec.agent?.session.header.cwd ?? process.cwd()
      const dir = outputDirFor(cwd)
      const outputPath = join(dir, args.file_name.replaceAll('\\', '/')).replace(/\/\.\//g, '/')
      await mkdir(dirname(outputPath), { recursive: true })
      const request = buildCodexPrompt(args.prompt, outputPath)
      const background = args.run_in_background ?? true

      if (!background) {
        // Foreground: the tool-call signal is the deadline; the seam escalates
        // tree termination after the grace period.
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
        const onCallAbort = () => controller.abort()
        exec.signal.addEventListener('abort', onCallAbort, { once: true })
        let handle: SubprocessHandle
        try {
          const startedAt = Date.now()
          handle = spawnCodex(ctx, cfg, request, cwd, controller.signal)
          const outcome = await settleOutcome(handle, outputPath, startedAt)
          if (outcome.status === 'completed') {
            const bytes = await stat(outputPath).then((info: { size: number }) => info.size, () => 0)
            const ok: ImageGenResult = { kind: 'foreground', status: 'ok', path: outputPath, bytes }
            return { result: ok }
          }
          const message = `${outcome.detail ?? 'failed'}${outcome.output !== undefined ? `: ${outcome.output}` : ''}`
          const failed: ImageGenResult = { kind: 'foreground', status: 'error', message }
          return { result: failed }
        } finally {
          clearTimeout(timer)
          exec.signal.removeEventListener('abort', onCallAbort)
        }
      }

      // Background: after the job id is published, the job's own cancellation
      // (job_kill / owner dispose / service teardown) owns the lifetime.
      const controller = new AbortController()
      let handle: SubprocessHandle | undefined
      // Registry rows bind the owning session and output path: job ids restart
      // from 1 in every host process, so the id alone would collide across
      // restarts and mislabel older cards.
      const owner = { sessionId: exec.agent?.session.header.id ?? '', outputPath }
      const setJobState = (state: ArtifactJobState): void => {
        jobStates.set(jobId, { state, ...owner })
      }
      const jobId = ctx.jobs.start({
        kind: 'image-gen',
        label: `image_gen → ${args.file_name}`,
        ...exec.agent !== undefined ? { owner: exec.agent } : {},
        run() {
          const startedAt = Date.now()
          handle = spawnCodex(ctx, cfg, request, cwd, controller.signal)
          const done = settleOutcome(handle, outputPath, startedAt)
          void done.then(outcome => {
            // A cancel records `killed` synchronously; the settled outcome of a
            // killed tree ("exit 0, no image") must not overwrite that fact.
            if (jobStates.get(jobId)?.state.status === 'killed') return
            setJobState(jobStateOf(outcome))
          }, (error: unknown) => {
            setJobState({ status: 'failed', detail: `codex launch failed: ${String(error)}` })
          })
          return {
            cancel(reason: string | undefined) {
              setJobState({ status: 'killed' })
              controller.abort()
              handle?.terminate()
              void reason
            },
            done,
          }
        },
      })
      setJobState({ status: 'running' })
      const started: ImageGenResult = { kind: 'background', jobId }
      return { result: started }
    },
  }))
}
