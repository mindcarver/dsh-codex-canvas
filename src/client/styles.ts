/**
 * Stylesheet for the `image_gen` tool card. Injected once as a
 * `<style data-plugin="dsh-codex-canvas">` tag (the module loader removes
 * plugin-owned tags on unload); classes are prefixed `dshcc-` and colors ride
 * `--dsw-*` design tokens with literal fallbacks.
 *
 * @module dsh-codex-canvas/client/styles
 */

/** Plugin id stamped on the injected tag (matches the bundle handoff id). */
export const STYLE_PLUGIN_ID = 'dsh-codex-canvas'

const SHEET = `
.dshcc-card { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.dshcc-row { position: relative; overflow: hidden; display: flex; align-items: center; gap: 6px; min-height: 24px; min-width: 0; font-size: 12px; }
.dshcc-card[data-state='generating'] .dshcc-row::after {
  content: ''; position: absolute; inset: 0 auto 0 0; width: 300px; pointer-events: none;
  background: linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--dsw-alias-bg-base, #888) 60%, transparent) 55%, transparent 100%);
  animation: dshcc-sweep 2.6s ease-out infinite;
}
@keyframes dshcc-sweep { 0% { left: -300px; } 90%, 100% { left: 100%; } }
@media (prefers-reduced-motion: reduce) { .dshcc-card[data-state='generating'] .dshcc-row::after { animation: none; } }
.dshcc-leading { flex: none; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; color: var(--dsw-alias-label-tertiary, #9b9b9b); }
.dshcc-title { flex: none; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }
.dshcc-sep { flex: none; width: 1px; height: 12px; background: var(--dsw-alias-border, currentColor); opacity: .35; }
.dshcc-summary { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, inherit); }
.dshcc-sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.dshcc-status { font-size: 12px; color: var(--dsw-alias-label-secondary, #9b9b9b); overflow-wrap: anywhere; }
.dshcc-detail { font-size: 12px; color: var(--dsw-alias-label-secondary, #9b9b9b); overflow-wrap: anywhere; }
.dshcc-detail[data-error] { color: var(--dsw-alias-danger, #d5443c); }
.dshcc-fallback { max-height: 200px; overflow: auto; margin: 0; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-sunken, rgba(127,127,127,.08)); font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary, inherit); }
.dshcc-figure { margin: 0; display: flex; flex-direction: column; gap: 4px; min-width: 0; max-width: 100%; }
.dshcc-thumb { padding: 0; border: 1px solid var(--dsw-alias-border, rgba(127,127,127,.35)); border-radius: 8px; background: none; cursor: zoom-in; display: block; max-width: 100%; }
.dshcc-thumb img { display: block; max-width: 100%; max-height: 260px; border-radius: 7px; }
.dshcc-thumb:focus-visible, .dshcc-close:focus-visible { outline: 2px solid var(--dsw-alias-focus, #4d9fff); outline-offset: 2px; }
.dshcc-caption { font-size: 12px; color: var(--dsw-alias-label-tertiary, #9b9b9b); overflow-wrap: anywhere; }
.dshcc-overlay { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center; padding: 24px; background: rgba(0, 0, 0, .72); }
.dshcc-dialog { position: relative; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; max-width: 100%; max-height: 100%; }
.dshcc-close { width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center; border: none; border-radius: 50%; background: rgba(255,255,255,.18); color: #fff; font-size: 18px; line-height: 1; cursor: pointer; }
.dshcc-close:hover { background: rgba(255,255,255,.3); }
.dshcc-zoom { display: block; max-width: min(1200px, 100%); max-height: calc(100vh - 96px); border-radius: 8px; box-shadow: 0 8px 40px rgba(0,0,0,.4); }
@media (max-width: 480px) { .dshcc-overlay { padding: 10px; } .dshcc-thumb img { max-height: 180px; } }
`

/**
 * Inject the stylesheet once; idempotent across plugin re-evaluation.
 * @returns disposer removing the tag when the plugin unloads.
 */
export function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.querySelector(`style[data-plugin=${JSON.stringify(STYLE_PLUGIN_ID)}]`)
  if (existing !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = STYLE_PLUGIN_ID
  tag.textContent = SHEET
  document.head.appendChild(tag)
  return () => { tag.remove() }
}
