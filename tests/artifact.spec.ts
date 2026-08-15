import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { probeArtifact, readArtifactImage, resolveArtifactPath } from '../src/artifact.ts'

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3])
const JPEG = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 1, 2])

let root: string
let cwd: string

beforeEach(async () => {
  root = join(tmpdir(), `dshcc-artifact-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  cwd = join(root, 'ws')
  await mkdir(join(cwd, 'images', 'icons'), { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('resolveArtifactPath', () => {
  it('resolves inside the workspace images root', () => {
    const p = resolveArtifactPath(cwd, 'icons/logo.png')!
    expect(p.startsWith(join(cwd, 'images') + '/')).toBe(true)
  })

  it.each(['../x.png', '/abs.png', 'a/../../x.png', 'a/./b.png', '', 'a//b.png', 'C:/x.png'])(
    'refuses invalid name %s', (name) => {
      expect(resolveArtifactPath(cwd, name)).toBeUndefined()
    },
  )
})

describe('readArtifactImage', () => {
  it('reads a PNG and a JPEG with correct mime', async () => {
    await writeFile(join(cwd, 'images', 'a.png'), PNG)
    await writeFile(join(cwd, 'images', 'b.jpg'), JPEG)
    expect(await readArtifactImage(cwd, 'a.png', 1024)).toMatchObject({ mime: 'image/png', bytes: PNG.length })
    expect(await readArtifactImage(cwd, 'b.jpg', 1024)).toMatchObject({ mime: 'image/jpeg', bytes: JPEG.length })
  })

  it('reads through nested directories', async () => {
    await writeFile(join(cwd, 'images', 'icons', 'logo.png'), PNG)
    expect(await readArtifactImage(cwd, 'icons/logo.png', 1024)).toMatchObject({ mime: 'image/png' })
  })

  it('refuses a missing file as not-found', async () => {
    expect(await readArtifactImage(cwd, 'missing.png', 1024)).toEqual({ error: 'not-found' })
  })

  it('refuses a non-image file as not-image', async () => {
    await writeFile(join(cwd, 'images', 'text.png'), Buffer.from('definitely not an image'))
    expect(await readArtifactImage(cwd, 'text.png', 1024)).toEqual({ error: 'not-image' })
  })

  it('refuses an oversized file as too-large', async () => {
    await writeFile(join(cwd, 'images', 'big.png'), PNG)
    expect(await readArtifactImage(cwd, 'big.png', 4)).toEqual({ error: 'too-large', bytes: PNG.length, maxBytes: 4 })
  })

  it('refuses a symlinked final component', async () => {
    await writeFile(join(root, 'outside.png'), PNG)
    await symlink(join(root, 'outside.png'), join(cwd, 'images', 'link.png'))
    expect(await readArtifactImage(cwd, 'link.png', 1024)).toEqual({ error: 'symlink' })
  })

  it('refuses a symlinked ancestor directory escaping the images root', async () => {
    await mkdir(join(root, 'elsewhere'), { recursive: true })
    await writeFile(join(root, 'elsewhere', 'escape.png'), PNG)
    await symlink(join(root, 'elsewhere'), join(cwd, 'images', 'linked-dir'))
    expect(await readArtifactImage(cwd, 'linked-dir/escape.png', 1024)).toEqual({ error: 'escapes' })
  })

  it('refuses a directory as not-regular', async () => {
    await mkdir(join(cwd, 'images', 'dir.png'))
    expect(await readArtifactImage(cwd, 'dir.png', 1024)).toEqual({ error: 'not-regular' })
  })

  it('refuses traversal names as invalid-name', async () => {
    await writeFile(join(root, 'outside.png'), PNG)
    expect(await readArtifactImage(cwd, '../outside.png', 1024)).toEqual({ error: 'invalid-name' })
    expect(await readArtifactImage(cwd, 'icons/../../outside.png', 1024)).toEqual({ error: 'invalid-name' })
  })
})

describe('probeArtifact', () => {
  it('reports present with size for a real file', async () => {
    await writeFile(join(cwd, 'images', 'a.png'), PNG)
    expect(await probeArtifact(cwd, 'a.png')).toEqual({ present: true, bytes: PNG.length })
  })

  it('collapses every refusal to present:false', async () => {
    expect(await probeArtifact(cwd, 'missing.png')).toEqual({ present: false })
    await writeFile(join(root, 'outside.png'), PNG)
    await symlink(join(root, 'outside.png'), join(cwd, 'images', 'link.png'))
    expect(await probeArtifact(cwd, 'link.png')).toEqual({ present: false })
  })
})
