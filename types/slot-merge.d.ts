/**
 * Module augmentations against packages that DO resolve from node_modules.
 * The `export {}` keeps this file a module, so both `declare module` blocks
 * below are augmentations rather than shadowing ambient declarations.
 */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'tool.call.toolview': { kind: 'keyed'; scope: 'session'; owner: import('@deepseek-ai/dsh-client-ui-tool/client').ToolCallOwnerProps }
  }
  /** The runtime package merges the concrete members; declared here because
   * dsh-client-runtime is not installable as a compile-time dependency. */
  interface SessionStandardProps {
    readonly sessionId: string
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Keyed UI slot registry (provided by the client runtime at runtime). */
    slots: {
      inject(key: string, setup: () => unknown): void
      register(options: { name: string; key?: string; locale?: string }, component: unknown): () => void
    }
    /** Session persistence service (dsh-session-persistence does not augment
     * the published rc types; structural slice of the surface consumed). */
    sessionPersistence: {
      inspect(id: string, signal?: AbortSignal): Promise<{ events: readonly { type: string; data: unknown }[]; meta: { id: string; cwd?: string | undefined } }>
      listSnapshots(signal?: AbortSignal): Promise<readonly { header: { id: string } }[]>
    }
  }
}

export {}
