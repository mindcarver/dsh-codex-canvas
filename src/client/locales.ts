/**
 * Dictionaries for the `image_gen` tool card. Registered under the
 * `codexCanvas` namespace; keys merge into the harness LocaleNamespaceMap.
 *
 * @module dsh-codex-canvas/client/locales
 */

/** Locale namespace this plugin owns. */
export const NS = 'codexCanvas'

const zh = {
  'row.title': '图片生成',
  'row.running': '生成中…',
  'row.failed': '生成失败',
  'row.stopped': '已停止',
  'row.interrupted': '生成已中断（服务重启），可让模型重新生成',
  'row.unavailable': '图片不再可用（文件可能已被移动或删除）',
  'image.zoom': '查看大图',
  'image.close': '关闭',
} as const

const en: Record<keyof typeof zh, string> = {
  'row.title': 'Image generation',
  'row.running': 'Generating…',
  'row.failed': 'Generation failed',
  'row.stopped': 'Stopped',
  'row.interrupted': 'Generation was interrupted (host restart); ask the model to retry',
  'row.unavailable': 'Image no longer available (file may have been moved or deleted)',
  'image.zoom': 'View full size',
  'image.close': 'Close',
}

/** Dictionary key union for LocaleNamespaceMap merging. */
export type LocaleKey = keyof typeof zh

export const dictionaries = { zh, en } as const
