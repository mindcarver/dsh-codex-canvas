// image_gen tool card: renders the generating/failed/stopped states from the
// durable block, polls the plugin's protected RPC while a background
// generation runs, and shows the finished PNG/JPEG inline with an accessible
// zoom dialog. Pure over the block; polled state lives in component state.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import {
  formatBytes, imageRowModel, imageValueOf, statusValueOf, type ImageValue, type RowPhase,
} from './model.ts'
import type { NS } from './locales.ts'

/** Wire outcome the injected caller normalizes to. */
export type RpcOutcomeLike = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }

/** Caller the plugin body wires to `ctx.connection.rpc.call`. */
export type ArtifactRpc = (endpoint: 'status' | 'image', payload: { sessionId: string; callId: string; artifactId: string }) => Promise<RpcOutcomeLike>

/** Full row props: the toolview runtime share plus this plugin's locale seat and RPC caller. */
export type ImageRowProps = ToolCallViewProps & PropsLocale<typeof NS> & { readonly rpc: ArtifactRpc }

/** Terminal answer of the status poll. */
type Polled =
  | { phase: 'running' }
  | { phase: 'done'; bytes: number }
  | { phase: 'failed'; detail: string }
  | { phase: 'stopped' }
  | { phase: 'interrupted' }
  | { phase: 'unavailable' }

const POLL_INTERVAL_MS = 2_500
const POLL_MAX_FAST_RETRIES = 5

/** Merge model, poll outcome, and fetch failure into the phase the card renders. */
function effectivePhase(modelPhase: RowPhase, polled: Polled | null, imageFailed: boolean, image: ImageValue | null): RowPhase {
  if (modelPhase === 'fallback' || modelPhase === 'stopped' || modelPhase === 'failed') return modelPhase
  if (modelPhase === 'done' || polled?.phase === 'done') {
    return image !== null ? 'done' : imageFailed ? 'unavailable' : 'generating'
  }
  if (polled === null) return modelPhase
  switch (polled.phase) {
    case 'running': return 'generating'
    case 'failed': return 'failed'
    case 'stopped': return 'stopped'
    case 'interrupted': return 'interrupted'
    case 'unavailable': return 'unavailable'
  }
}

/** Inline image glyph (no matching primitive exists; self-contained stroke icon). */
function ImageGlyph({ size = 14 }: { size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="5.5" cy="6.5" r="1.3" stroke="currentColor" strokeWidth="1.1" />
      <path d="M2.5 12 L6.5 8 L9 10.5 L11 8.5 L13.5 11" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

/** Accessible zoom dialog: Esc and backdrop close, focus moved in and restored. */
function ZoomDialog({ src, fileName, zoomLabel, closeLabel, onClose }: {
  src: string
  fileName: string
  zoomLabel: string
  closeLabel: string
  onClose: () => void
}): ReactNode {
  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [onClose])
  return createPortal(
    <div
      className="dshcc-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="dshcc-dialog" role="dialog" aria-modal="true" aria-label={zoomLabel}>
        <button ref={closeRef} type="button" className="dshcc-close" aria-label={closeLabel} onClick={onClose}>×</button>
        <img className="dshcc-zoom" src={src} alt={fileName} />
      </div>
    </div>,
    document.body,
  )
}

/**
 * Render one `image_gen` call as a summary row plus inline image artifact.
 * @param props - toolview payload, locale seat, and the RPC caller.
 * @returns the dedicated image row.
 */
export function ImageRow({ block, sessionId, t, rpc }: ImageRowProps): ReactNode {
  const model = imageRowModel(block)
  const [polled, setPolled] = useState<Polled | null>(null)
  const [image, setImage] = useState<ImageValue | null>(null)
  const [imageFailed, setImageFailed] = useState(false)
  const [zoom, setZoom] = useState(false)

  const meta = model.meta
  const artifactId = meta?.artifactId
  useEffect(() => {
    if (!model.poll || artifactId === undefined || sessionId === undefined) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let fastRetries = 0
    const tick = async (): Promise<void> => {
      const outcome = await rpc('status', { sessionId, callId: block.callId, artifactId })
      if (cancelled) return
      const value = outcome.ok ? statusValueOf(outcome.value) : undefined
      if (value === undefined) {
        fastRetries += 1
        timer = setTimeout(tick, fastRetries <= POLL_MAX_FAST_RETRIES ? POLL_INTERVAL_MS : 15_000)
        return
      }
      switch (value.status) {
        case 'running':
          timer = setTimeout(tick, POLL_INTERVAL_MS)
          return
        case 'completed':
          setPolled({ phase: 'done', bytes: value.bytes ?? 0 })
          return
        case 'failed':
          setPolled({ phase: 'failed', detail: value.detail ?? '' })
          return
        case 'killed':
          setPolled({ phase: 'stopped' })
          return
        case 'interrupted':
          setPolled({ phase: 'interrupted' })
          return
        case 'unavailable':
          setPolled({ phase: 'unavailable' })
          return
      }
    }
    void tick()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [model.poll, artifactId, sessionId, block.callId, rpc])

  const wantImage = (model.phase === 'done' || polled?.phase === 'done') && meta !== null
  useEffect(() => {
    if (!wantImage || image !== null || imageFailed || artifactId === undefined || sessionId === undefined) return
    let cancelled = false
    void (async () => {
      const outcome = await rpc('image', { sessionId, callId: block.callId, artifactId })
      if (cancelled) return
      const value = outcome.ok ? imageValueOf(outcome.value) : undefined
      if (value === undefined) {
        setImageFailed(true)
        return
      }
      setImage(value)
    })()
    return () => {
      cancelled = true
    }
  }, [wantImage, image, imageFailed, artifactId, sessionId, block.callId, rpc])

  const phase = effectivePhase(model.phase, polled, imageFailed, image)
  const summary = model.fileName ?? block.callId
  const statusLine = ((): string | null => {
    switch (phase) {
      case 'generating': return t('row.running')
      case 'failed': return polled?.phase === 'failed' && polled.detail !== '' ? polled.detail : (model.detail ?? t('row.failed'))
      case 'stopped': return t('row.stopped')
      case 'interrupted': return t('row.interrupted')
      case 'unavailable': return t('row.unavailable')
      default: return null
    }
  })()

  const leading = phase === 'failed'
    ? <StateDot state="error" />
    : phase === 'stopped' || phase === 'interrupted' || phase === 'unavailable'
      ? <StateDot state="warning" />
      : <ImageGlyph />

  return (
    <div className="dshcc-card" data-tool="image_gen" data-state={phase}>
      <div className="dshcc-row">
        <span className="dshcc-leading">{leading}</span>
        <span className="dshcc-title">{t('row.title')}</span>
        <span className="dshcc-sep" aria-hidden="true" />
        <span className="dshcc-summary">{summary}</span>
      </div>
      {phase === 'done' && image !== null
        ? (
          <figure className="dshcc-figure">
            <button
              type="button"
              className="dshcc-thumb"
              aria-label={`${t('image.zoom')} ${summary}`}
              onClick={() => { setZoom(true) }}
            >
              <img src={`data:${image.mime};base64,${image.data}`} alt={summary} loading="lazy" />
            </button>
            <figcaption className="dshcc-caption">{summary} · {formatBytes(image.bytes)}</figcaption>
          </figure>
          )
        : null}
      {statusLine !== null && phase !== 'done'
        ? <div className={phase === 'failed' ? 'dshcc-detail' : 'dshcc-status'} data-error={phase === 'failed' || undefined}>{statusLine}</div>
        : null}
      {phase === 'fallback' && model.detail !== null ? <pre className="dshcc-fallback">{model.detail}</pre> : null}
      {zoom && image !== null
        ? (
          <ZoomDialog
            src={`data:${image.mime};base64,${image.data}`}
            fileName={summary}
            zoomLabel={t('image.zoom')}
            closeLabel={t('image.close')}
            onClose={() => { setZoom(false) }}
          />
          )
        : null}
    </div>
  )
}
