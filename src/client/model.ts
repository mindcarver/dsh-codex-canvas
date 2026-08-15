/**
 * Pure view-model for the `image_gen` tool card. Derived solely from the
 * durable block slice (args, result text, presentationMeta) plus the polled
 * RPC status the component feeds in — no I/O, no clocks, replay-stable.
 *
 * @module dsh-codex-canvas/client/model
 */

import { artifactMetaFromMeta, type ImageGenArtifactMeta } from '../shared/meta.ts'

/** Structural slice of `RunningToolCall | ToolResultNode` the model consumes. */
export interface ModelBlock {
  /** Present only on settled result nodes. */
  readonly kind?: string
  readonly callId: string
  readonly argsRaw?: string
  readonly call?: { readonly argsRaw?: string } | null
  readonly content?: readonly { readonly type: string; readonly text?: string }[]
  readonly isError?: boolean
  readonly error?: { readonly code: string } | undefined
  readonly meta?: unknown
}

/** Render phases the card distinguishes. */
export type RowPhase = 'generating' | 'done' | 'failed' | 'stopped' | 'unavailable' | 'interrupted' | 'fallback'

/** What the card needs from the model. */
export interface ImageRowModel {
  readonly phase: RowPhase
  readonly fileName: string | null
  readonly meta: ImageGenArtifactMeta | null
  /** Start polling the RPC status endpoint (background descriptor, settled). */
  readonly poll: boolean
  /** First result-text line for error/fallback summaries. */
  readonly detail: string | null
}

function argsRawOf(block: ModelBlock): string {
  return (block.kind !== undefined ? block.call?.argsRaw : block.argsRaw) ?? ''
}

/** Extract `file_name` from the raw call arguments; streaming may truncate them. */
export function fileNameOf(block: ModelBlock): string | null {
  const raw = argsRawOf(block)
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null) {
      const name = (parsed as Record<string, unknown>).file_name
      if (typeof name === 'string' && name.trim().length > 0) return name
    }
  } catch {
    // Truncated JSON while streaming: fall back to nothing.
  }
  return null
}

/** Flatten durable result blocks to text, mirroring the generic row contract. */
export function resultText(block: ModelBlock): string | null {
  if (block.kind === undefined) return null
  const parts: string[] = []
  for (const item of block.content ?? []) {
    parts.push(item.type === 'text' ? (item.text ?? '') : JSON.stringify(item))
  }
  if (parts.length === 0 && block.error !== undefined) {
    parts.push(`${block.error.code}`)
  }
  return parts.join('\n') || null
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/**
 * Derive the initial card model from the durable block.
 * @param block - running or settled tool-call node.
 * @returns the model the component renders and extends with polled state.
 */
export function imageRowModel(block: ModelBlock): ImageRowModel {
  const fileName = fileNameOf(block)
  if (block.kind === undefined) {
    return { phase: 'generating', fileName, meta: null, poll: false, detail: null }
  }
  const interrupted = block.error?.code === 'interrupted'
  const meta = artifactMetaFromMeta(block.meta)
  if (meta === undefined) {
    return { phase: 'fallback', fileName, meta: null, poll: false, detail: resultText(block) }
  }
  if (interrupted) {
    return { phase: 'stopped', fileName, meta, poll: false, detail: resultText(block) }
  }
  if (meta.kind === 'background') {
    return { phase: 'generating', fileName, meta, poll: true, detail: null }
  }
  if (meta.status === 'error') {
    return { phase: 'failed', fileName, meta, poll: false, detail: firstLine(resultText(block) ?? '') || null }
  }
  return { phase: 'done', fileName, meta, poll: false, detail: null }
}

/** Human byte size for the caption. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`
  return `${bytes} B`
}

/** Narrowed `status` RPC value. */
export interface StatusValue {
  readonly status: 'running' | 'completed' | 'failed' | 'killed' | 'interrupted' | 'unavailable'
  readonly bytes?: number
  readonly detail?: string
}

/**
 * Defensively narrow an untrusted `status` RPC value.
 * @param value - untrusted RPC payload.
 * @returns the status, or undefined when malformed.
 */
export function statusValueOf(value: unknown): StatusValue | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  switch (record.status) {
    case 'running':
    case 'killed':
    case 'interrupted':
    case 'unavailable':
      return { status: record.status }
    case 'completed':
      return typeof record.bytes === 'number' && Number.isSafeInteger(record.bytes) && record.bytes >= 0
        ? { status: 'completed', bytes: record.bytes }
        : undefined
    case 'failed':
      return typeof record.detail === 'string' ? { status: 'failed', detail: record.detail } : { status: 'failed', detail: '' }
    default:
      return undefined
  }
}

/** Narrowed `image` RPC value. */
export interface ImageValue {
  readonly mime: 'image/png' | 'image/jpeg'
  readonly bytes: number
  readonly data: string
}

/**
 * Defensively narrow an untrusted `image` RPC value.
 * @param value - untrusted RPC payload.
 * @returns the image payload, or undefined when malformed.
 */
export function imageValueOf(value: unknown): ImageValue | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if ((record.mime !== 'image/png' && record.mime !== 'image/jpeg')
    || typeof record.data !== 'string' || record.data.length === 0
    || typeof record.bytes !== 'number' || !Number.isSafeInteger(record.bytes) || record.bytes < 0) {
    return undefined
  }
  return { mime: record.mime, bytes: record.bytes, data: record.data }
}
