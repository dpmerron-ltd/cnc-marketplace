import type { ExportSnapshot } from '../src/machine/exportSnapshot'
import { createTabMapPdf } from '../src/printing/tabMapPdf'
import type { TelegramSender, TelegramStore } from './telegram'
import { html, siteUrl } from './telegramFormat'

export interface TabRunSummary { id: string; name: string; status: string; created_at: string }
export interface TabRun extends TabRunSummary { snapshot: Pick<ExportSnapshot, 'version' | 'map'> }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const short = (text: string) => text.replace(/\s+/g, ' ').slice(0, 65)

export async function tabsReply(chat: string, arg: string, store: TelegramStore, send: TelegramSender, font?: Uint8Array) {
  if (!store.tabRuns || !store.tabRun || !font) throw Error('Tab maps are unavailable. Try again shortly.')
  if (!arg || /^page \d{1,5}$/.test(arg)) {
    const offset = arg ? Number(arg.split(' ')[1]) : 0
    const runs = await store.tabRuns(offset)
    if (!runs.length) { await send(chat, '📌 No saved CNC exports on this page. Export the sheet’s NC first, then use /tabs.'); return }
    const buttons = runs.map(run => [{ text: `${short(run.name)} · ${run.created_at.slice(0, 10)} · ${run.status} · ${run.id.slice(0, 8)}`, callback_data: `tabs:${run.id}` }])
    if (offset) buttons.push([{ text: '← Newer exports', callback_data: `tabs:page ${Math.max(0, offset - 10)}` }])
    if (runs.length === 10) buttons.push([{ text: 'Older exports →', callback_data: `tabs:page ${offset + 10}` }])
    await send(chat, '📌 <b>Sheet tab maps</b>\n\nChoose the saved CNC export you are cutting. Then choose a sheet.\n\nMaps match that export; later layout edits are not included.', { reply_markup: { inline_keyboard: buttons } })
    return
  }
  const [id, sheetText, extra] = arg.split(/\s+/)
  if (!uuid.test(id) || extra || (sheetText && !/^[1-9]\d{0,3}$/.test(sheetText))) throw Error('Use /tabs to choose an export and sheet, or /tabs EXPORT-ID SHEET-NUMBER.')
  const run = await store.tabRun(id.toLowerCase())
  if (!run || run.snapshot?.version !== 1 || !run.snapshot.map?.parts?.length) throw Error('This saved export has no available tab map. Use /tabs to choose another export.')
  const map = run.snapshot.map
  const indices = [...new Set(map.parts.map(part => part.sheetIndex))].sort((a, b) => a - b)
  if (!sheetText) {
    // Keep keyboards bounded even for unusually large saved jobs.
    for (let start = 0; start < indices.length; start += 40) {
      await send(chat, `📌 <b>${html(short(run.name))}</b>\nSaved ${html(run.created_at)} · ${html(run.status)}\nExport <code>${run.id}</code>\n\nChoose a sheet:`, { reply_markup: { inline_keyboard: indices.slice(start, start + 40).map(index => [{ text: `Sheet ${index + 1} · ${map.parts.filter(part => part.sheetIndex === index).length} parts`, callback_data: `tabs:${run.id} ${index + 1}` }]) } })
    }
    return
  }
  const index = Number(sheetText) - 1
  if (!indices.includes(index)) throw Error('That sheet is not in this export. Use /tabs and choose a listed sheet.')
  await send(chat, `⏳ Preparing tab map for <b>${html(short(run.name))} · Sheet ${index + 1}</b>…`)
  const parts = map.parts.filter(part => part.sheetIndex === index)
  const count = parts.reduce((total, part) => total + part.tabs.length, 0)
  const bytes = await createTabMapPdf({ ...map, name: `${run.name} | Export ${run.id.slice(0, 8)} | ${run.created_at.slice(0, 10)}` }, font, [index])
  const caption = `📌 <b>${html(short(run.name))} · Sheet ${index + 1}</b>\n${parts.length} parts · ${count} identified tab locations\n\n🟡 Highlighted spans = tabs. Part detail pages include X/Y positions.\n📐 Origin: bottom-left; X right, Y up.\n📂 Saved ${html(run.created_at.slice(0, 10))} · ${html(run.status)}\n${parts.some(part => part.warnings.length) ? '⚠️ Source warnings are included in the PDF.\n' : ''}\nSaved export map — verify the NC export and orientation match your sheet. Stop the machine before removing tabs.\n<a href="${siteUrl}/${run.id}?sheet=${index + 1}">Open interactive sheet ↗</a>`
  await send(chat, caption, { document: { bytes, filename: `tabs-${run.id}-sheet-${index + 1}.pdf` } })
}
