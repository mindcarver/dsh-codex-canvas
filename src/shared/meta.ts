/**
 * UI-only artifact descriptor for `image_gen` results, persisted through
 * `output.presentationMeta` on the `tool/result` event. Carries references
 * only (never image bytes): the Web client re-reads the file through the
 * plugin's protected RPC after the host re-validates call ownership.
 *
 * Shared verbatim between the Node half (`src/index.ts`, `src/rpc.ts`) and the
 * browser half (`src/client/*`); each bundle inlines its own copy because the
 * two halves never share module identity.
 *
 * @module dsh-codex-canvas/shared/meta
 */

/** Discriminant stamped on every descriptor this plugin persists. */
export const META_PLUGIN = 'codex-canvas'

/** Connection RPC channel this plugin owns; the browser half calls `<channel>/<endpoint>`. */
export const RPC_CHANNEL = '/codex-canvas'

/** Descriptor revision; a shape change must bump this and re-narrow old rows. */
export const META_VERSION = 1

/** Descriptor variant for a background start: the image arrives later via the job. */
export type BackgroundArtifactMeta = {
  readonly v: typeof META_VERSION
  readonly plugin: typeof META_PLUGIN
  readonly artifactId: string
  readonly fileName: string
  readonly kind: 'background'
  readonly jobId: string
}

/** Descriptor variant for a foreground success: the file existed when the call returned. */
export type ForegroundOkArtifactMeta = {
  readonly v: typeof META_VERSION
  readonly plugin: typeof META_PLUGIN
  readonly artifactId: string
  readonly fileName: string
  readonly kind: 'foreground'
  readonly status: 'ok'
  readonly bytes: number
}

/** Descriptor variant for a foreground failure: the render text owns the detail. */
export type ForegroundErrorArtifactMeta = {
  readonly v: typeof META_VERSION
  readonly plugin: typeof META_PLUGIN
  readonly artifactId: string
  readonly fileName: string
  readonly kind: 'foreground'
  readonly status: 'error'
}

/** Union of every descriptor this plugin may persist. */
export type ImageGenArtifactMeta = BackgroundArtifactMeta | ForegroundOkArtifactMeta | ForegroundErrorArtifactMeta

/**
 * Normalize a caller-supplied relative file name. Accepts backslash
 * separators and surrounding whitespace; rejects anything that could escape
 * the workspace `images/` directory (absolute paths, drive letters, `..`,
 * `.` and empty segments) or exceed a sane length.
 * @param raw - untrusted value.
 * @returns the normalized forward-slash name, or undefined when invalid.
 */
export function normalizeFileName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const normalized = raw.replaceAll('\\', '/').trim()
  if (normalized.length === 0 || normalized.length > 512) return undefined
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return undefined
  if (/[\u0000-\u001f\u007f]/.test(normalized)) return undefined
  const segments = normalized.split('/')
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') return undefined
  }
  return segments.join('/')
}

/**
 * Derive the deterministic artifact handle for one normalized file name.
 * @param fileName - normalized workspace-relative name.
 * @returns the artifact id persisted in the descriptor.
 */
export function artifactIdFor(fileName: string): string {
  return `v${META_VERSION}:${fileName}`
}

/** Tool-call argument slice the projection consumes. */
export interface MetaArgs {
  readonly file_name: string
}

/** Canonical `image_gen` value slice the projection consumes. */
export type MetaValue =
  | { readonly kind: 'background'; readonly jobId: string }
  | { readonly kind: 'foreground'; readonly status: 'ok'; readonly bytes: number }
  | { readonly kind: 'foreground'; readonly status: 'error'; readonly message: string }

/**
 * Project one validated tool value into the persisted UI descriptor. Pure and
 * deterministic (the artifact id derives from the file name), so the harness
 * replay contract holds. Returns null instead of a degenerate descriptor when
 * the stored arguments fail normalization — the Web card then falls back to
 * the plain text row.
 * @param args - validated tool arguments.
 * @param value - validated canonical tool value.
 * @returns the descriptor, or null when no safe descriptor exists.
 */
export function artifactMetaFromValue(args: MetaArgs, value: MetaValue): ImageGenArtifactMeta | null {
  const fileName = normalizeFileName(args.file_name)
  if (fileName === undefined) return null
  const base = { v: META_VERSION, plugin: META_PLUGIN, artifactId: artifactIdFor(fileName), fileName } as const
  if (value.kind === 'background') {
    return typeof value.jobId === 'string' && value.jobId.length > 0
      ? { ...base, kind: 'background', jobId: value.jobId }
      : null
  }
  if (value.status === 'ok') {
    return typeof value.bytes === 'number' && Number.isSafeInteger(value.bytes) && value.bytes >= 0
      ? { ...base, kind: 'foreground', status: 'ok' as const, bytes: value.bytes }
      : null
  }
  return { ...base, kind: 'foreground', status: 'error' as const }
}

/**
 * Defensively narrow an untrusted `tool/result` meta back to a descriptor.
 * Every field is re-validated (including the artifact-id/file-name binding),
 * so a tampered or foreign meta can never smuggle a path past the RPC check.
 * @param meta - untrusted persisted value.
 * @returns the descriptor, or undefined when it is not one of ours.
 */
export function artifactMetaFromMeta(meta: unknown): ImageGenArtifactMeta | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined
  const record = meta as Record<string, unknown>
  if (record.v !== META_VERSION || record.plugin !== META_PLUGIN) return undefined
  if (typeof record.artifactId !== 'string' || record.artifactId.length === 0) return undefined
  const fileName = normalizeFileName(record.fileName)
  if (fileName === undefined || record.artifactId !== artifactIdFor(fileName)) return undefined
  const base = { v: META_VERSION, plugin: META_PLUGIN, artifactId: record.artifactId, fileName } as const
  if (record.kind === 'background') {
    return typeof record.jobId === 'string' && record.jobId.length > 0
      ? { ...base, kind: 'background' as const, jobId: record.jobId }
      : undefined
  }
  if (record.kind === 'foreground' && record.status === 'ok') {
    return typeof record.bytes === 'number' && Number.isSafeInteger(record.bytes) && record.bytes >= 0
      ? { ...base, kind: 'foreground' as const, status: 'ok' as const, bytes: record.bytes }
      : undefined
  }
  if (record.kind === 'foreground' && record.status === 'error') {
    return { ...base, kind: 'foreground' as const, status: 'error' as const }
  }
  return undefined
}

/** RPC request binding one artifact read to the call that produced it. */
export interface ArtifactRequest {
  readonly sessionId: string
  readonly callId: string
  readonly artifactId: string
}

/**
 * Narrow an untrusted RPC payload into a request triple.
 * @param payload - untrusted JSON body.
 * @returns the request, or undefined when malformed.
 */
export function artifactRequestFromPayload(payload: unknown): ArtifactRequest | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { sessionId, callId, artifactId } = payload as Record<string, unknown>
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 256) return undefined
  if (typeof callId !== 'string' || callId.length === 0 || callId.length > 256) return undefined
  if (typeof artifactId !== 'string' || artifactId.length === 0 || artifactId.length > 512) return undefined
  return { sessionId, callId, artifactId }
}
