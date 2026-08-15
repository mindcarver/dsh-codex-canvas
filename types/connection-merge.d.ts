/**
 * Module augmentation wiring the ambient connection shim onto the cordis
 * Context. Module file (export {}) so the block augments the real package.
 */

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Connection transport and RPC registrations. */
    connection: import('@deepseek-ai/dsh-client-connection').HostConnectionHandle
  }
}

export {}
