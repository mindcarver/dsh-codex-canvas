import { describe, expect, it } from 'vitest'
import { artifactMetaFromValue } from '../src/shared/meta.ts'
import { fileNameOf, formatBytes, imageRowModel, resultText } from '../src/client/model.ts'

const bgMeta = artifactMetaFromValue({ file_name: 'shiba.png' }, { kind: 'background', jobId: 'job-7' })!
const fgOk = artifactMetaFromValue({ file_name: 'shiba.png' }, { kind: 'foreground', status: 'ok', bytes: 10 })!
const fgErr = artifactMetaFromValue({ file_name: 'shiba.png' }, { kind: 'foreground', status: 'error', message: 'x' })!

const args = JSON.stringify({ prompt: 'a shiba', file_name: 'shiba.png' })

describe('fileNameOf', () => {
  it('reads file_name from running and settled shapes', () => {
    expect(fileNameOf({ callId: 'c', argsRaw: args })).toBe('shiba.png')
    expect(fileNameOf({ kind: 'tool-result', callId: 'c', call: { argsRaw: args } })).toBe('shiba.png')
  })

  it('tolerates truncated streaming JSON', () => {
    expect(fileNameOf({ callId: 'c', argsRaw: '{"prompt":"a","file_name":"shi' })).toBeNull()
    expect(fileNameOf({ callId: 'c' })).toBeNull()
  })
})

describe('imageRowModel', () => {
  it('shows generating before the call settles (no polling yet)', () => {
    expect(imageRowModel({ callId: 'c', argsRaw: args })).toEqual({
      phase: 'generating', fileName: 'shiba.png', meta: null, poll: false, detail: null,
    })
  })

  it('settled background descriptor keeps generating but starts polling', () => {
    const model = imageRowModel({ kind: 'tool-result', callId: 'c', call: { argsRaw: args }, content: [{ type: 'text', text: 'started background job 7' }], meta: bgMeta })
    expect(model.phase).toBe('generating')
    expect(model.poll).toBe(true)
    expect(model.meta).toEqual(bgMeta)
  })

  it('foreground ok is done immediately (fetch, no polling)', () => {
    const model = imageRowModel({ kind: 'tool-result', callId: 'c', call: { argsRaw: args }, content: [{ type: 'text', text: 'image written' }], meta: fgOk })
    expect(model).toMatchObject({ phase: 'done', poll: false })
  })

  it('foreground error surfaces the model-visible first line', () => {
    const model = imageRowModel({
      kind: 'tool-result', callId: 'c', call: { argsRaw: args },
      content: [{ type: 'text', text: 'image generation failed: codex exit code: 1\nsecond line' }], meta: fgErr,
    })
    expect(model).toMatchObject({ phase: 'failed', detail: 'image generation failed: codex exit code: 1' })
  })

  it('falls back to plain text when the meta is absent or foreign', () => {
    const model = imageRowModel({ kind: 'tool-result', callId: 'c', call: { argsRaw: args }, content: [{ type: 'text', text: 'plain output' }], meta: { plugin: 'other' } })
    expect(model).toMatchObject({ phase: 'fallback', detail: 'plain output' })
  })

  it('marks interrupted calls stopped', () => {
    const model = imageRowModel({ kind: 'tool-result', callId: 'c', call: { argsRaw: args }, content: [], error: { code: 'interrupted' }, meta: bgMeta })
    expect(model.phase).toBe('stopped')
  })
})

describe('resultText / formatBytes', () => {
  it('joins text blocks and reports error codes', () => {
    expect(resultText({ kind: 'tool-result', callId: 'c', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a\nb')
    expect(resultText({ kind: 'tool-result', callId: 'c', content: [], error: { code: 'interrupted' } })).toBe('interrupted')
    expect(resultText({ callId: 'c' })).toBeNull()
  })

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KiB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MiB')
  })
})
