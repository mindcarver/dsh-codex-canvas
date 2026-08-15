/**
 * Browser half of dsh-codex-canvas, loaded through `exports["./client"]` by
 * the harness client-module system. Registers the keyed `image_gen` toolview
 * and its dictionaries; the card reads the persisted artifact descriptor and
 * talks to the plugin's Node half over the `/codex-canvas` Connection RPC.
 *
 * @module dsh-codex-canvas/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { RPC_CHANNEL } from '../shared/meta.ts'
import { ImageRow, type ArtifactRpc, type ImageRowProps, type RpcOutcomeLike } from './ImageRow.tsx'
import { dictionaries, NS, type LocaleKey } from './locales.ts'
import { injectStyles } from './styles.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The `image_gen` tool card's copy. */
    codexCanvas: LocaleKey
  }
}

/** Required services: the slot registry, the RPC-capable connection, and locale. */
export const inject = ['slots', 'connection', 'locale']

/** Structural slice of the client connection handle (kept local to stay decoupled). */
interface ConnectionRpcFace {
  rpc: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcOutcomeLike> }
}

const RPC_TIMEOUT_MS = 30_000

/**
 * Client plugin body: styles, dictionaries, and the keyed tool row.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => injectStyles(), 'codex-canvas: styles')
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'codex-canvas: dictionaries')

  const connection = ctx.get('connection') as unknown as ConnectionRpcFace
  const rpc: ArtifactRpc = async (endpoint, payload) => {
    try {
      return await connection.rpc.call(RPC_CHANNEL, endpoint, payload, AbortSignal.timeout(RPC_TIMEOUT_MS))
    } catch (error: unknown) {
      return { ok: false, error: { code: 'transport', message: String(error) } }
    }
  }
  const Row = (props: ImageRowProps) => <ImageRow {...props} rpc={rpc} />

  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register({ name: 'tool.call.toolview', key: 'image_gen', locale: NS }, Row))
}
