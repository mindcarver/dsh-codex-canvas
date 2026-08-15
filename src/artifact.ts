/**
 * Node-side artifact reading with workspace containment. Every read passes
 * the same gate: normalized relative name, containment under the session
 * workspace's `images/` directory (lexical and post-symlink-resolution),
 * regular-file requirement, size cap, and a PNG/JPEG magic-byte check.
 *
 * @module dsh-codex-canvas/artifact
 */

import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { normalizeFileName } from './shared/meta.ts'

/** Default cap for one image served through the RPC (a gpt-image-2 PNG is ~1-3 MiB). */
export const DEFAULT_MAX_IMAGE_BYTES = 25 * 1024 * 1024

/** Why a read was refused; `reason` strings are stable for tests and UI copy. */
export type ArtifactReadError = { readonly error: 'invalid-name' | 'not-found' | 'not-regular' | 'symlink' | 'escapes' | 'not-image' }
  | { readonly error: 'too-large'; readonly bytes: number; readonly maxBytes: number }

/** One successfully read artifact image. */
export interface ArtifactImage {
  readonly mime: 'image/png' | 'image/jpeg'
  readonly bytes: number
  readonly data: Buffer
}

/** Existence probe used by the status endpoint. */
export type ArtifactProbe = { readonly present: false } | { readonly present: true; readonly bytes: number }

/** PNG and JPEG signatures; anything else is refused as `not-image`. */
function mimeOf(head: Buffer): 'image/png' | 'image/jpeg' | undefined {
  if (head.length >= 8
    && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4E && head[3] === 0x47
    && head[4] === 0x0D && head[5] === 0x0A && head[6] === 0x1A && head[7] === 0x0A) {
    return 'image/png'
  }
  if (head.length >= 3 && head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) {
    return 'image/jpeg'
  }
  return undefined
}

/** Resolve the fixed `images/` root for one session workspace. */
export function artifactImagesRoot(cwd: string): string {
  return resolve(cwd, 'images')
}

/**
 * Lexically resolve a file name inside the workspace `images/` directory.
 * @param cwd - session workspace directory.
 * @param fileName - untrusted relative name.
 * @returns the contained absolute path, or undefined when the name is invalid.
 */
export function resolveArtifactPath(cwd: string, fileName: unknown): string | undefined {
  const normalized = normalizeFileName(fileName)
  if (normalized === undefined) return undefined
  const root = artifactImagesRoot(cwd)
  const path = resolve(root, normalized)
  if (path !== root && !path.startsWith(root + sep)) return undefined
  return path
}

interface Gate {
  readonly path: string
  readonly bytes: number
}

/**
 * Shared gate: resolve, reject symlinked final components, verify the
 * post-symlink path stays inside the real `images/` root, require a regular
 * file, and enforce the size cap. `maxBytes` of 0 skips the size check (the
 * probe only needs presence and size).
 */
async function gateArtifact(
  cwd: string,
  fileName: unknown,
  maxBytes: number,
): Promise<Gate | ArtifactReadError> {
  const path = resolveArtifactPath(cwd, fileName)
  if (path === undefined) return { error: 'invalid-name' }
  let info
  try {
    info = await lstat(path)
  } catch {
    return { error: 'not-found' }
  }
  if (info.isSymbolicLink()) return { error: 'symlink' }
  const root = artifactImagesRoot(cwd)
  let realPath: string
  let realRoot: string
  try {
    ;[realPath, realRoot] = await Promise.all([realpath(path), realpath(root)])
  } catch {
    return { error: 'not-found' }
  }
  if (realPath !== realRoot && !realPath.startsWith(realRoot + sep)) return { error: 'escapes' }
  if (!info.isFile()) return { error: 'not-regular' }
  const size = (await stat(path)).size
  if (maxBytes > 0 && size > maxBytes) return { error: 'too-large', bytes: size, maxBytes }
  return { path, bytes: size }
}

/**
 * Probe whether the artifact file currently exists (post-containment).
 * @param cwd - session workspace directory.
 * @param fileName - untrusted relative name.
 * @returns presence and byte size; every refusal collapses to `present: false`.
 */
export async function probeArtifact(cwd: string, fileName: string): Promise<ArtifactProbe> {
  const gate = await gateArtifact(cwd, fileName, 0)
  return 'error' in gate ? { present: false } : { present: true, bytes: gate.bytes }
}

/**
 * Read one artifact image after passing the full gate.
 * @param cwd - session workspace directory.
 * @param fileName - untrusted relative name.
 * @param maxBytes - size cap in bytes.
 * @returns the image, or a discriminated refusal.
 */
export async function readArtifactImage(
  cwd: string,
  fileName: string,
  maxBytes: number,
): Promise<ArtifactImage | ArtifactReadError> {
  const gate = await gateArtifact(cwd, fileName, maxBytes)
  if ('error' in gate) return gate
  const data = await readFile(gate.path)
  const mime = mimeOf(data.subarray(0, 8))
  if (mime === undefined) return { error: 'not-image' }
  return { mime, bytes: data.length, data }
}
