import { describe, expect, it } from 'vitest'
import {
  artifactIdFor, artifactMetaFromMeta, artifactMetaFromValue, artifactRequestFromPayload, normalizeFileName,
} from '../src/shared/meta.ts'

describe('normalizeFileName', () => {
  it.each([
    ['hero.png', 'hero.png'],
    ['icons/logo.png', 'icons/logo.png'],
    ['icons\\logo.png', 'icons/logo.png'],
    ['  hero.png  ', 'hero.png'],
    ['a.b.c.png', 'a.b.c.png'],
    ['图1.png', '图1.png'],
  ])('accepts %s -> %s', (raw, expected) => {
    expect(normalizeFileName(raw)).toBe(expected)
  })

  it.each([
    '', '   ', '/etc/passwd', 'C:/x.png', 'c:\\x.png', '../escape.png', 'a/../b.png', 'a/./b.png',
    'a//b.png', 'a/', './x.png', '..', 'a/..', 123, null, undefined, {}, 'x\0.png',
  ])('rejects %s', (raw) => {
    expect(normalizeFileName(raw)).toBeUndefined()
  })
})

describe('artifactMetaFromValue', () => {
  const args = { file_name: 'shiba.png' }

  it('projects a background start with jobId', () => {
    expect(artifactMetaFromValue(args, { kind: 'background', jobId: 'j1' })).toEqual({
      v: 1, plugin: 'codex-canvas', artifactId: 'v1:shiba.png', fileName: 'shiba.png',
      kind: 'background', jobId: 'j1',
    })
  })

  it('projects foreground success with bytes', () => {
    expect(artifactMetaFromValue(args, { kind: 'foreground', status: 'ok', bytes: 42 })).toEqual({
      v: 1, plugin: 'codex-canvas', artifactId: 'v1:shiba.png', fileName: 'shiba.png',
      kind: 'foreground', status: 'ok', bytes: 42,
    })
  })

  it('projects foreground failure without leaking the message', () => {
    expect(artifactMetaFromValue(args, { kind: 'foreground', status: 'error', message: 'boom' })).toEqual({
      v: 1, plugin: 'codex-canvas', artifactId: 'v1:shiba.png', fileName: 'shiba.png',
      kind: 'foreground', status: 'error',
    })
  })

  it('is deterministic for equal inputs (pure projection)', () => {
    const a = artifactMetaFromValue(args, { kind: 'background', jobId: 'j1' })
    const b = artifactMetaFromValue(args, { kind: 'background', jobId: 'j1' })
    expect(a).toEqual(b)
    expect(a!.artifactId).toBe(artifactIdFor('shiba.png'))
  })

  it('returns null for degenerate values or unnormalizable names', () => {
    expect(artifactMetaFromValue({ file_name: '../evil.png' }, { kind: 'background', jobId: 'j' })).toBeNull()
    expect(artifactMetaFromValue(args, { kind: 'background', jobId: '' })).toBeNull()
    expect(artifactMetaFromValue(args, { kind: 'foreground', status: 'ok', bytes: -1 })).toBeNull()
    expect(artifactMetaFromValue(args, { kind: 'foreground', status: 'ok', bytes: 1.5 })).toBeNull()
  })
})

describe('artifactMetaFromMeta', () => {
  it('round-trips every projection the value path can emit', () => {
    const inputs = [
      artifactMetaFromValue({ file_name: 'a.png' }, { kind: 'background', jobId: 'job-9' }),
      artifactMetaFromValue({ file_name: 'b/c.png' }, { kind: 'foreground', status: 'ok', bytes: 7 }),
      artifactMetaFromValue({ file_name: 'd.png' }, { kind: 'foreground', status: 'error', message: 'x' }),
    ]
    for (const meta of inputs) {
      expect(artifactMetaFromMeta(meta)).toEqual(meta)
    }
  })

  it('rejects foreign or tampered metas', () => {
    const good = artifactMetaFromValue({ file_name: 'a.png' }, { kind: 'background', jobId: 'job-9' })
    expect(artifactMetaFromMeta(undefined)).toBeUndefined()
    expect(artifactMetaFromMeta(null)).toBeUndefined()
    expect(artifactMetaFromMeta('x')).toBeUndefined()
    expect(artifactMetaFromMeta({ ...good, artifactId: 'v1:other.png' })).toBeUndefined()
    expect(artifactMetaFromMeta({ ...good, fileName: '../escape.png' })).toBeUndefined()
    expect(artifactMetaFromMeta({ ...good, plugin: 'other' })).toBeUndefined()
    expect(artifactMetaFromMeta({ ...good, v: 2 })).toBeUndefined()
    expect(artifactMetaFromMeta({ ...good, kind: 'background', jobId: '' })).toBeUndefined()
    expect(artifactMetaFromMeta({ v: 1, plugin: 'codex-canvas', artifactId: 'v1:a.png', fileName: 'a.png', kind: 'mystery' })).toBeUndefined()
    expect(artifactMetaFromMeta({ v: 1, plugin: 'codex-canvas', artifactId: 'v1:a.png', fileName: 'a.png', kind: 'foreground', status: 'ok', bytes: '9' })).toBeUndefined()
  })
})

describe('artifactRequestFromPayload', () => {
  it('accepts a well-formed triple', () => {
    expect(artifactRequestFromPayload({ sessionId: 's', callId: 'c', artifactId: 'v1:a.png' }))
      .toEqual({ sessionId: 's', callId: 'c', artifactId: 'v1:a.png' })
  })

  it.each([
    undefined, null, 'x', 5, {}, { sessionId: '', callId: 'c', artifactId: 'a' },
    { sessionId: 's', callId: 'c' }, { sessionId: 's', callId: 'c', artifactId: 7 },
  ])('rejects malformed payload %s', (payload) => {
    expect(artifactRequestFromPayload(payload)).toBeUndefined()
  })
})
