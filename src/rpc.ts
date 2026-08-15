/**
 * The `/codex-canvas` Connection RPC surface: two endpoints (`status`,
 * `image`) through which the Web tool card observes and fetches one image
 * artifact. Every request is re-authorized against the session log — the
 * `tool/call` must name `image_gen`, the paired `tool/result` must carry one
 * of this plugin's descriptors, and the requested `artifactId` must equal the
 * persisted one — before any filesystem access happens inside that session's
 * workspace `images/` directory.
 *
 * Structurally typed against the harness surfaces it consumes so an external
 * plugin stays decoupled from internal package versions; events arrive from
 * durable storage (a wire boundary), so runtime narrowing is mandatory.
 *
 * @module dsh-codex-canvas/rpc
 */

import { probeArtifact, readArtifactImage, resolveArtifactPath, type ArtifactProbe, type ArtifactReadError } from './artifact.ts'
import { artifactMetaFromMeta, artifactRequestFromPayload, RPC_CHANNEL, type ArtifactRequest, type ImageGenArtifactMeta } from './shared/meta.ts'

export { RPC_CHANNEL }

/** Live-job memory for background generations started by this process. */
export type ArtifactJobState =
  | { readonly status: 'running' }
  | { readonly status: 'completed' }
  | { readonly status: 'failed'; readonly detail: string }
  | { readonly status: 'killed' }

/** Minimal structural view of one session-log event. */
export interface SessionEventLike {
  readonly type: string
  readonly data: unknown
}

/** Structural slice of a live `Session` from the `sessions` service. */
export interface SessionLike {
  readonly events: readonly SessionEventLike[]
  readonly header: { readonly cwd?: string | undefined }
}

/** Structural slice of a `SessionInspection` from `sessionPersistence`. */
export interface SessionInspectionLike {
  readonly events: readonly SessionEventLike[]
  readonly meta: { readonly id: string; readonly cwd?: string | undefined }
}

/** Structural slice of the harness services the handler consumes. */
export interface RpcServices {
  readonly sessions: { get(id: string): SessionLike | undefined }
  readonly sessionPersistence: {
    inspect(id: string, signal?: AbortSignal): Promise<SessionInspectionLike>
    listSnapshots(signal?: AbortSignal): Promise<readonly { header: { id: string } }[]>
  }
}

/**
 * One registry row. Job ids restart from 1 in every host process, so the id
 * alone cannot identify a generation: each row also carries the owning
 * session and the exact output path, and a lookup only counts when both
 * match the persisted descriptor being served.
 */
export interface ArtifactJobEntry {
  readonly state: ArtifactJobState
  readonly sessionId: string
  readonly outputPath: string
}

/** Registry the tool body updates as background jobs settle. */
export interface ArtifactJobRegistryLike {
  get(jobId: string): ArtifactJobEntry | undefined
}

/** Wire outcome shape shared with the harness RPC envelope. */
export type RpcOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: Record<string, unknown> } }

/** Status the tool card can act on. */
export type ArtifactStatusValue =
  | { readonly status: 'running' }
  | { readonly status: 'completed'; readonly bytes: number }
  | { readonly status: 'failed'; readonly detail: string }
  | { readonly status: 'killed' }
  | { readonly status: 'interrupted' }
  | { readonly status: 'unavailable' }

/** Stable refusal reasons carried through the `attachment-error` RPC code. */
type Reason =
  | 'CALL_NOT_FOUND' | 'FORBIDDEN' | 'NOT_FOUND' | 'NOT_REGULAR' | 'SYMLINK'
  | 'ESCAPES' | 'TOO_LARGE' | 'NOT_IMAGE' | 'INVALID_NAME' | 'INTERNAL'

const ENDPOINTS = ['status', 'image'] as const

function ok<T>(value: T): RpcOutcome<T> {
  return { ok: true, value }
}

function badRequest(message: string): RpcOutcome<never> {
  return { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }
}

function sessionNotFound(sessionId: string): RpcOutcome<never> {
  return { ok: false, error: { code: 'session-not-found', message: 'no such session', details: { sessionId } } }
}

function refused(reason: Reason, message: string): RpcOutcome<never> {
  return { ok: false, error: { code: 'attachment-error', message, details: { reason } } }
}

interface ToolCallData { readonly callId: string; readonly name: string }
interface ToolResultData { readonly callId: unknown; readonly meta: unknown }

function toolCallData(data: unknown): ToolCallData | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as Record<string, unknown>
  if (typeof record.callId !== 'string' || typeof record.name !== 'string') return undefined
  return { callId: record.callId, name: record.name }
}

function toolResultData(data: unknown): ToolResultData | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const record = data as Record<string, unknown>
  const message = record.message
  if (typeof message !== 'object' || message === null) return undefined
  const source = (message as Record<string, unknown>).source
  const callId = typeof source === 'object' && source !== null ? (source as Record<string, unknown>).callId : undefined
  return { callId, meta: record.meta }
}

/**
 * Locate the `image_gen` call/result pair for one callId and return the
 * descriptor the harness persisted for it.
 */
function authorize(
  events: readonly SessionEventLike[],
  request: ArtifactRequest,
): { meta: ImageGenArtifactMeta } | 'call-not-found' | 'forbidden' {
  let meta: unknown
  let sawResult = false
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type === 'tool/result' && !sawResult) {
      const data = toolResultData(event.data)
      if (data !== undefined && data.callId === request.callId) {
        meta = data.meta
        sawResult = true
      }
      continue
    }
    if (event.type === 'tool/call') {
      const data = toolCallData(event.data)
      if (data !== undefined && data.callId === request.callId) {
        if (data.name !== 'image_gen') return 'call-not-found'
        if (!sawResult) return 'call-not-found'
        const narrowed = artifactMetaFromMeta(meta)
        if (narrowed === undefined || narrowed.artifactId !== request.artifactId) return 'forbidden'
        return { meta: narrowed }
      }
    }
  }
  return 'call-not-found'
}

function readErrorReason(error: ArtifactReadError): Reason {
  return error.error === 'too-large' ? 'TOO_LARGE'
    : error.error === 'not-found' ? 'NOT_FOUND'
      : error.error === 'not-regular' ? 'NOT_REGULAR'
        : error.error === 'symlink' ? 'SYMLINK'
          : error.error === 'escapes' ? 'ESCAPES'
            : error.error === 'not-image' ? 'NOT_IMAGE'
              : 'INVALID_NAME'
}

/**
 * Compute the observable status for one authorized descriptor.
 * @param meta - the persisted descriptor (already authorized).
 * @param registry - in-process background-job memory.
 * @param probe - filesystem presence check inside the session workspace.
 * @param owner - session id and resolved output path the descriptor names;
 *   a registry row whose owner differs belongs to another process's
 *   same-numbered job and must not answer for this call.
 */
export async function artifactStatusFor(
  meta: ImageGenArtifactMeta,
  registry: ArtifactJobRegistryLike,
  probe: () => Promise<ArtifactProbe>,
  owner: { readonly sessionId: string; readonly outputPath: string },
): Promise<ArtifactStatusValue> {
  const present = await probe()
  if (meta.kind === 'foreground') {
    if (meta.status === 'error') return { status: 'failed', detail: '' }
    return present.present ? { status: 'completed', bytes: present.bytes } : { status: 'unavailable' }
  }
  if (present.present) return { status: 'completed', bytes: present.bytes }
  const entry = registry.get(meta.jobId)
  const job = entry !== undefined && entry.sessionId === owner.sessionId && entry.outputPath === owner.outputPath
    ? entry.state
    : undefined
  if (job === undefined) return { status: 'interrupted' }
  switch (job.status) {
    case 'running': return { status: 'running' }
    case 'completed': return { status: 'unavailable' }
    case 'failed': return { status: 'failed', detail: job.detail }
    case 'killed': return { status: 'killed' }
  }
}

/** Injectable seams so tests can drive the handler without a real host. */
export interface ArtifactRpcOptions {
  readonly services: RpcServices
  readonly registry: ArtifactJobRegistryLike
  readonly maxImageBytes: number
}

/**
 * Build the `/codex-canvas` RPC handler.
 * @param options - services, job registry, and size cap.
 * @returns the handler matching the harness `ConnectionRpcHandler` shape.
 */
export function createArtifactRpcHandler(options: ArtifactRpcOptions) {
  return async (endpoint: string, payload: unknown, _signal: AbortSignal): Promise<RpcOutcome<unknown>> => {
    try {
      if (!(ENDPOINTS as readonly string[]).includes(endpoint)) {
        return badRequest(`unknown endpoint "${endpoint}"`)
      }
      const request = artifactRequestFromPayload(payload)
      if (request === undefined) return badRequest('payload must be { sessionId, callId, artifactId }')

      const live = options.services.sessions.get(request.sessionId)
      let events: readonly SessionEventLike[]
      let cwd: string | undefined
      if (live !== undefined) {
        events = live.events
        cwd = live.header.cwd
      } else {
        const snapshots = await options.services.sessionPersistence.listSnapshots()
        if (!snapshots.some(snapshot => snapshot.header.id === request.sessionId)
          && options.services.sessions.get(request.sessionId) === undefined) {
          return sessionNotFound(request.sessionId)
        }
        const inspection = await options.services.sessionPersistence.inspect(request.sessionId)
        events = inspection.events
        cwd = inspection.meta.cwd
      }
      if (typeof cwd !== 'string' || cwd.length === 0) {
        return refused('INTERNAL', 'session has no resolvable workspace cwd')
      }

      const authorized = authorize(events, request)
      if (authorized === 'call-not-found') return refused('CALL_NOT_FOUND', 'no image_gen result for this call in this session')
      if (authorized === 'forbidden') return refused('FORBIDDEN', 'artifact does not belong to this call')

      if (endpoint === 'status') {
        const status = await artifactStatusFor(
          authorized.meta,
          options.registry,
          () => probeArtifact(cwd, authorized.meta.fileName),
          {
            sessionId: request.sessionId,
            outputPath: resolveArtifactPath(cwd, authorized.meta.fileName) ?? '',
          },
        )
        return ok(status)
      }
      const read = await readArtifactImage(cwd, authorized.meta.fileName, options.maxImageBytes)
      if ('error' in read) {
        return refused(readErrorReason(read), `artifact refused: ${read.error}`)
      }
      return ok({ mime: read.mime, bytes: read.bytes, data: read.data.toString('base64') })
    } catch (error: unknown) {
      return refused('INTERNAL', `codex-canvas rpc failed: ${String(error)}`)
    }
  }
}
