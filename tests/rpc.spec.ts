import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveArtifactPath } from '../src/artifact.ts'
import { artifactMetaFromValue } from '../src/shared/meta.ts'
import { createArtifactRpcHandler, type ArtifactJobState, type RpcServices, type SessionEventLike } from '../src/rpc.ts'

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 9, 9])

let root: string
let cwdA: string
let cwdB: string

beforeEach(async () => {
  root = join(tmpdir(), `dshcc-rpc-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  cwdA = join(root, 'ws-a')
  cwdB = join(root, 'ws-b')
  await mkdir(join(cwdA, 'images'), { recursive: true })
  await mkdir(join(cwdB, 'images'), { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function callEvent(callId: string, name = 'image_gen'): SessionEventLike {
  return { type: 'tool/call', data: { turn: 1, step: 1, callId, name, arguments: '{"prompt":"p","file_name":"a.png"}' } }
}

function resultEvent(callId: string, meta?: unknown): SessionEventLike {
  return {
    type: 'tool/result',
    data: {
      turn: 1, step: 1,
      message: { role: 'tool', source: { callId }, content: [{ type: 'text', text: 'ok' }] },
      ...(meta !== undefined ? { meta } : {}),
    },
  }
}

const bgMeta = artifactMetaFromValue({ file_name: 'a.png' }, { kind: 'background', jobId: 'job-1' })!
const fgOkMeta = artifactMetaFromValue({ file_name: 'a.png' }, { kind: 'foreground', status: 'ok', bytes: PNG.length })!

interface Fixture {
  events: SessionEventLike[]
  cwd: string
  live?: boolean
}

function services(fixtures: Record<string, Fixture>): RpcServices {
  return {
    sessions: { get: id => fixtures[id]?.live === true ? { events: fixtures[id].events, header: { cwd: fixtures[id].cwd } } : undefined },
    sessionPersistence: {
      listSnapshots: async () => Object.keys(fixtures).map(id => ({ header: { id } })),
      inspect: async id => {
        const fixture = fixtures[id]
        if (fixture === undefined) throw new Error('inspect: unknown session')
        return { events: fixture.events, meta: { id, cwd: fixture.cwd } }
      },
    },
  }
}

function makeHandler(
  svc: RpcServices,
  states: Record<string, ArtifactJobState> = {},
  maxImageBytes = 1024,
  ownerOverride: { sessionId?: string; outputPath?: string } = {},
) {
  const registry = {
    get: (jobId: string) => states[jobId] === undefined ? undefined : {
      state: states[jobId],
      sessionId: ownerOverride.sessionId ?? 's-a',
      outputPath: ownerOverride.outputPath ?? resolveArtifactPath(cwdA, 'a.png')!,
    },
  }
  const handler = createArtifactRpcHandler({ services: svc, registry, maxImageBytes })
  return { handler, call: (endpoint: string, payload: unknown) => handler(endpoint, payload, new AbortController().signal) }
}

const REQ = { sessionId: 's-a', callId: 'call-1', artifactId: bgMeta.artifactId }

describe('codex-canvas rpc status', () => {
  it('reports running while the background job is in flight', async () => {
    const { call } = makeHandler(services({ 's-a': { events: [callEvent('call-1'), resultEvent('call-1', bgMeta)], cwd: cwdA } }), { 'job-1': { status: 'running' } })
    expect(await call('status', REQ)).toEqual({ ok: true, value: { status: 'running' } })
  })

  it('reports completed with bytes once the file exists (no registry needed — replay path)', async () => {
    await writeFile(join(cwdA, 'images', 'a.png'), PNG)
    const { call } = makeHandler(services({ 's-a': { events: [callEvent('call-1'), resultEvent('call-1', bgMeta)], cwd: cwdA } }))
    expect(await call('status', REQ)).toEqual({ ok: true, value: { status: 'completed', bytes: PNG.length } })
  })

  it('reports failed with the job detail', async () => {
    const { call } = makeHandler(services({ 's-a': { events: [callEvent('call-1'), resultEvent('call-1', bgMeta)], cwd: cwdA } }), { 'job-1': { status: 'failed', detail: 'codex exit code: 1' } })
    expect(await call('status', REQ)).toEqual({ ok: true, value: { status: 'failed', detail: 'codex exit code: 1' } })
  })

  it('reports killed after job_kill', async () => {
    const { call } = makeHandler(services({ 's-a': { events: [callEvent('call-1'), resultEvent('call-1', bgMeta)], cwd: cwdA } }), { 'job-1': { status: 'killed' } })
    expect(await call('status', REQ)).toEqual({ ok: true, value: { status: 'killed' } })
  })

  it('reports interrupted when neither file nor in-process job memory exists (host restarted mid-run)', async () => {
    const { call } = makeHandler(services({ 's-a': { events: [callEvent('call-1'), resultEvent('call-1', bgMeta)], cwd: cwdA } }))
    expect(await call('status', REQ)).toEqual({ ok: true, value: { status: 'interrupted' } })
  })

  it('does not let a restarted host\'s same-numbered job answer for an older call (jobId collision)', async () => {
    const svc = services({ 's-a': { events: [callEvent('call-1'), resultEvent('call-1', bgMeta)], cwd: cwdA } })
    // Same jobId, but the registry row belongs to a different output path
    // (another generation in the NEW host process): it must not speak for
    // this descriptor.
    const foreignPath = makeHandler(svc, { 'job-1': { status: 'completed' } }, 1024, { outputPath: resolveArtifactPath(cwdA, 'other.png')! })
    expect(await foreignPath.call('status', REQ)).toEqual({ ok: true, value: { status: 'interrupted' } })
    // Same jobId owned by a different session: same verdict.
    const foreignSession = makeHandler(svc, { 'job-1': { status: 'completed' } }, 1024, { sessionId: 's-b' })
    expect(await foreignSession.call('status', REQ)).toEqual({ ok: true, value: { status: 'interrupted' } })
    // Matching owner still answers normally.
    const own = makeHandler(svc, { 'job-1': { status: 'failed', detail: 'x' } })
    expect(await own.call('status', REQ)).toEqual({ ok: true, value: { status: 'failed', detail: 'x' } })
  })

  it('reports unavailable for a foreground ok whose file disappeared', async () => {
    const { call } = makeHandler(services({ 's-a': { events: [callEvent('call-1'), resultEvent('call-1', fgOkMeta)], cwd: cwdA } }))
    const req = { sessionId: 's-a', callId: 'call-1', artifactId: fgOkMeta.artifactId }
    expect(await call('status', req)).toEqual({ ok: true, value: { status: 'unavailable' } })
  })

  it('prefers the live session over persistence', async () => {
    await writeFile(join(cwdA, 'images', 'a.png'), PNG)
    const svc = services({ 's-a': { events: [callEvent('call-1'), resultEvent('call-1', bgMeta)], cwd: cwdA, live: true } })
    let inspected = false
    svc.sessionPersistence.inspect = async () => {
      inspected = true
      throw new Error('must not be called')
    }
    const { call } = makeHandler(svc)
    expect(await call('status', REQ)).toEqual({ ok: true, value: { status: 'completed', bytes: PNG.length } })
    expect(inspected).toBe(false)
  })
})

describe('codex-canvas rpc authorization (A5)', () => {
  const sessionA = () => ({ 's-a': { events: [callEvent('call-1'), resultEvent('call-1', bgMeta)], cwd: cwdA } })

  it('refuses an unknown session', async () => {
    const { call } = makeHandler(services({}))
    expect(await call('status', REQ)).toEqual({
      ok: false, error: { code: 'session-not-found', message: 'no such session', details: { sessionId: 's-a' } },
    })
  })

  it('refuses a callId that belongs to another session (cross-session read)', async () => {
    await writeFile(join(cwdB, 'images', 'a.png'), PNG)
    const { call } = makeHandler(services({
      's-a': { events: [callEvent('call-1'), resultEvent('call-1', bgMeta)], cwd: cwdA },
      's-b': { events: [callEvent('call-9'), resultEvent('call-9', bgMeta)], cwd: cwdB },
    }))
    const outcome = await call('status', { sessionId: 's-b', callId: 'call-1', artifactId: bgMeta.artifactId })
    expect(outcome).toEqual({
      ok: false, error: { code: 'attachment-error', message: expect.any(String), details: { reason: 'CALL_NOT_FOUND' } },
    })
  })

  it('refuses an artifactId that does not match the persisted descriptor', async () => {
    const { call } = makeHandler(services(sessionA()))
    expect(await call('status', { sessionId: 's-a', callId: 'call-1', artifactId: 'v1:other.png' }))
      .toMatchObject({ ok: false, error: { details: { reason: 'FORBIDDEN' } } })
  })

  it('refuses a callId owned by a different tool', async () => {
    const { call } = makeHandler(services({ 's-a': { events: [callEvent('call-1', 'job_output'), resultEvent('call-1', bgMeta)], cwd: cwdA } }))
    expect(await call('status', REQ)).toMatchObject({ ok: false, error: { details: { reason: 'CALL_NOT_FOUND' } } })
  })

  it('refuses a result without a plugin descriptor', async () => {
    const { call } = makeHandler(services({ 's-a': { events: [callEvent('call-1'), resultEvent('call-1', { v: 1, plugin: 'other' })], cwd: cwdA } }))
    expect(await call('status', REQ)).toMatchObject({ ok: false, error: { details: { reason: 'FORBIDDEN' } } })
  })

  it('refuses a dangling tool/call without a result', async () => {
    const { call } = makeHandler(services({ 's-a': { events: [callEvent('call-1')], cwd: cwdA } }))
    expect(await call('status', REQ)).toMatchObject({ ok: false, error: { details: { reason: 'CALL_NOT_FOUND' } } })
  })

  it('refuses malformed payloads and endpoints', async () => {
    const { call } = makeHandler(services(sessionA()))
    expect(await call('status', null)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await call('status', { sessionId: 's-a' })).toMatchObject({ ok: false, error: { code: 'bad-request' } })
    expect(await call('bogus', REQ)).toMatchObject({ ok: false, error: { code: 'bad-request' } })
  })

  it('collapses handler exceptions into INTERNAL instead of a transport 500', async () => {
    const svc = services({})
    svc.sessionPersistence.listSnapshots = async () => {
      throw new Error('boom')
    }
    const { call } = makeHandler(svc)
    expect(await call('status', REQ)).toMatchObject({ ok: false, error: { details: { reason: 'INTERNAL' } } })
  })
})

describe('codex-canvas rpc image', () => {
  const imageReq = { sessionId: 's-a', callId: 'call-1', artifactId: bgMeta.artifactId }

  it('serves a real PNG as base64 after full authorization', async () => {
    await writeFile(join(cwdA, 'images', 'a.png'), PNG)
    const { call } = makeHandler(services({ 's-a': { events: [callEvent('call-1'), resultEvent('call-1', bgMeta)], cwd: cwdA } }))
    const outcome = await call('image', imageReq)
    expect(outcome).toEqual({ ok: true, value: { mime: 'image/png', bytes: PNG.length, data: PNG.toString('base64') } })
  })

  it('refuses a missing file', async () => {
    const { call } = makeHandler(services({ 's-a': { events: [callEvent('call-1'), resultEvent('call-1', bgMeta)], cwd: cwdA } }))
    expect(await call('image', imageReq)).toMatchObject({ ok: false, error: { details: { reason: 'NOT_FOUND' } } })
  })

  it('refuses a non-image file even when fully authorized', async () => {
    await writeFile(join(cwdA, 'images', 'a.png'), Buffer.from('not an image at all'))
    const { call } = makeHandler(services({ 's-a': { events: [callEvent('call-1'), resultEvent('call-1', bgMeta)], cwd: cwdA } }))
    expect(await call('image', imageReq)).toMatchObject({ ok: false, error: { details: { reason: 'NOT_IMAGE' } } })
  })

  it('refuses an oversized file', async () => {
    await writeFile(join(cwdA, 'images', 'a.png'), PNG)
    const { call } = makeHandler(services({ 's-a': { events: [callEvent('call-1'), resultEvent('call-1', bgMeta)], cwd: cwdA } }), {}, 4)
    expect(await call('image', imageReq)).toMatchObject({ ok: false, error: { details: { reason: 'TOO_LARGE' } } })
  })

  it('refuses a symlinked final component and a symlinked escaping ancestor', async () => {
    await writeFile(join(root, 'outside.png'), PNG)
    await symlink(join(root, 'outside.png'), join(cwdA, 'images', 'a.png'))
    let outcome = await makeHandler(services({ 's-a': { events: [callEvent('call-1'), resultEvent('call-1', bgMeta)], cwd: cwdA } })).call('image', imageReq)
    expect(outcome).toMatchObject({ ok: false, error: { details: { reason: 'SYMLINK' } } })

    await rm(join(cwdA, 'images', 'a.png'))
    await mkdir(join(root, 'elsewhere'), { recursive: true })
    await writeFile(join(root, 'elsewhere', 'deep.png'), PNG)
    await symlink(join(root, 'elsewhere'), join(cwdA, 'images', 'sub'))
    const nested = artifactMetaFromValue({ file_name: 'sub/deep.png' }, { kind: 'background', jobId: 'job-2' })!
    const svc = services({ 's-a': { events: [callEvent('call-2'), resultEvent('call-2', nested)], cwd: cwdA } })
    outcome = await makeHandler(svc).call('image', { sessionId: 's-a', callId: 'call-2', artifactId: nested.artifactId })
    expect(outcome).toMatchObject({ ok: false, error: { details: { reason: 'ESCAPES' } } })
  })
})
