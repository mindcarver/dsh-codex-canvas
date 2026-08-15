/**
 * Ambient module declaration for the slice of
 * `@deepseek-ai/dsh-client-ui-tool/client` this plugin consumes (the
 * published package pulls an unpublished dependency closure, so it cannot
 * serve as a compile-time devDependency). Keep the shapes in sync with
 * `packages/client/ui-tool/src/client/contract/slots.ts` upstream.
 *
 * This file stays a script (no top-level export): the target module does not
 * resolve from node_modules, so this must be an ambient definition, not a
 * module augmentation.
 */

declare module '@deepseek-ai/dsh-client-ui-tool/client' {
  import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

  /** Structural slice of a running (unsettled) tool call node. */
  interface RunningToolCallShim {
    readonly callId: string
    readonly argsRaw?: string
  }

  /** Structural slice of a settled tool result node. */
  interface ToolResultShim {
    readonly kind: 'tool-result'
    readonly callId: string
    readonly call?: { readonly argsRaw?: string } | null
    readonly content?: readonly { readonly type: string; readonly text?: string }[]
    readonly isError?: boolean
    readonly error?: { readonly name: string; readonly code: string } | undefined
    readonly meta?: unknown
  }

  /** Owner props the keyed toolview hole passes to every row. */
  export interface ToolCallOwnerProps {
    readonly callId: string
    readonly toolName: string
    readonly block: RunningToolCallShim | ToolResultShim
    readonly cwd?: string | undefined
    readonly openFile: (path: string) => void
    readonly inspect?: (() => void) | undefined
  }

  export type ToolCallViewProps = PropsRuntime<'tool.call.toolview'>
}
