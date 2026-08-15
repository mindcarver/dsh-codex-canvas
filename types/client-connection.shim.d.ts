/**
 * Ambient module declaration for the slice of
 * `@deepseek-ai/dsh-client-connection` this plugin consumes (the published
 * package pulls an unpublished dependency closure through
 * dsh-host-apiproxy). Mirrors `packages/client/connection/src/rpc.ts`
 * upstream. Script file on purpose — see ui-tool-client.shim.d.ts.
 */

declare module '@deepseek-ai/dsh-client-connection' {
  /** Wire result envelope: JSON values only (binaries ride base64 strings). */
  export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; details?: unknown } }

  /** Handler contract for one RPC channel registration. */
  export interface ConnectionRpcHandler {
    (endpoint: string, payload: unknown, signal: AbortSignal): Promise<RpcResult<unknown>>
  }

  /** Host-side registration surface. */
  export interface HostConnectionRpc {
    handle(channel: string, handler: ConnectionRpcHandler, options: { authority: 'trusted-host' | 'loopback' }): Promise<() => void>
  }

  /** Host connection service face. */
  export interface HostConnectionHandle {
    readonly rpc: HostConnectionRpc
  }
}
