import type { SheetWorkspace } from '../src/jobs/production'
import { orderProgress, today } from '../src/jobs/production'
import { dailyPlanIsCurrent } from '../src/jobs/dailyPlan'
import { dailyMaterialRequirements } from '../src/jobs/dailyMaterials'
import type { ShopifyOrder } from '../src/orders/types'
export const siteUrl = 'https://dpmerron-ltd.github.io/cnc-marketplace/#machine'
export const html = (text: unknown) => String(text ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
const short = (text: string, max = 180) => { const clean = text.replace(/\s+/g, ' ').trim(); return clean.length > max ? clean.slice(0, max - 1) + '…' : clean }
const clock = (m:number) => `${String(Math.floor(Math.ceil(m)/60)).padStart(2,'0')}:${String(Math.ceil(m)%60).padStart(2,'0')}`
const pages = <T>(values:T[], size:number):T[][] => Array.from({length:Math.ceil(values.length/size)},(_,n)=>values.slice(n*size,(n+1)*size))
const column = (value:string|number,width:number) => short(String(value),width).padEnd(width)
export function planMessages(workspace:SheetWorkspace):string[]{
 const plan=workspace.dailyPlan
 if(!plan || plan.date!==today())return [`📅 <b>No saved cutting plan for today</b>\n\nCreate and save one in <a href="${siteUrl}">Cutting Jobs</a>.`]
 const materials=dailyMaterialRequirements(plan)
 const messages=[`🪚 <b>TODAY’S CUTS · ${html(plan.date)}</b>\n\n🕘 09:00–17:00 · 2 machines\n⏱ <b>${(plan.cuts.reduce((n,c)=>n+c.seconds,0)/3600).toFixed(1)} / 12 hours</b> cutting\n📋 <b>${plan.cuts.length} sheets</b> scheduled\n\n${dailyPlanIsCurrent(workspace)?'✅ Saved plan · times are estimates.':'⚠️ <b>Plan changed</b> — re-plan before relying on its times or materials.'}`]
 for(const group of pages(materials.materials,10))messages.push(`🪵 <b>Material to prepare</b>\n1220 × 1220 mm squares\n\n${group.map(m=>`▪️ <b>${m.squares} ×</b> ${html(short(m.material))}${m.reviewSheets?`\n   ⚠️ ${m.reviewSheets} layouts need stock review`:''}`).join('\n')}\n\n<b>Total confirmed squares: ${materials.totalSquares}</b>`)
 for(const group of pages(plan.orders,16)){
  const table=['Order     Today  Cut  Left  Plan',...group.map(o=>`${column(o.name,10)}${column(o.scheduled,7)}${column(o.cut,5)}${column(o.waiting+o.cutting+o.pending,6)}${o.pending?'Check':o.scheduled?(o.waiting||o.cutting?'Part':'All'):o.cut&&!o.waiting&&!o.cutting?'Cut':'Wait'}`)].join('\n')
  messages.push(`📦 <b>Orders in the plan</b>\n<pre>${html(table)}</pre>\n\nAll = all remaining planned today\nPart = partial today · Check = needs allocation\n<i>Counts are components; planned completion is not confirmation of cutting.</i>`)
 }
 for(const machine of [1,2]){
  const cuts=plan.cuts.filter(c=>c.machine===machine)
  for(const group of pages(cuts,5))messages.push(`⚙️ <b>MACHINE ${machine}</b>\n\n${group.map(c=>`<b>${clock(c.startMinute)}–${clock(c.endMinute)}</b> · Sheet ${c.sheetIndex+1} · ${c.parts} parts\n🪵 ${html(short(c.material))}\n📦 ${html(short(c.orders.join(', '),300))}`).join('\n\n')}`)
  if(!cuts.length)messages.push(`⚙️ <b>MACHINE ${machine}</b>\nNo cuts scheduled.`)
 }
 for(const group of pages(plan.issues,5))messages.push(`⚠️ <b>Needs attention</b>\n\n${group.map(issue=>'• '+html(short(issue,350))).join('\n\n')}`)
 messages.push(`🔎 <b>Find what you need</b>\n/today — saved day plan\n/orders — live saved progress\n/order 1047 — order details\n/scan — open the QR scanner\n\n<a href="${siteUrl}">Open Cutting Jobs ↗</a>`)
 return messages
}
export function progressMessage(workspace:SheetWorkspace,number?:string):string {
 const rows=orderProgress(workspace.jobs).filter(o=>!number||o.name.replace(/^#/,'').toLowerCase()===number.replace(/^#/,'').toLowerCase())
 if(!rows.length)return 'No saved cutting parts found for that order.'
 return 'SAVED CUTTING PROGRESS\n'+rows.map(o=>`${o.name}: ${o.cut} cut / ${o.cut+o.waiting+o.cutting+o.pending} components — ${!o.waiting&&!o.cutting&&!o.pending?'ALL PLANNED COMPONENTS CUT':'PARTIAL'}\n${o.waiting} waiting | ${o.cutting} cutting | ${o.pending} unallocated`).join('\n\n')
}
export function progressCards(workspace:SheetWorkspace):string[]{
 const rows=orderProgress(workspace.jobs)
 if(!rows.length)return ['📦 <b>No saved cutting parts yet</b>']
 return pages(rows,18).map(group=>`📦 <b>Saved order progress</b>\n<pre>${html(['Order      Cut Total  Left',...group.map(o=>`${column(o.name,11)}${column(o.cut,4)}${column(o.cut+o.waiting+o.cutting+o.pending,7)}${o.waiting+o.cutting+o.pending}`)].join('\n'))}</pre>\n\n✅ Left = 0: all planned components cut\n🟡 Left &gt; 0: work remains\n\nUse /order 1047 for items and details.`)
}
export function orderCards(order:ShopifyOrder,progress:string):string[]{
 const title=`📦 <b>ORDER ${html(short(order.name,60))}</b>`
 const messages=[`${title}\n${order.cancelledAt?'🔴 Cancelled':order.closedAt?'⚪ Closed':'🟢 Open'} · Placed ${html(order.createdAt?.slice(0,10)??'Unknown')}\n\n<b>🪚 Cutting progress</b>\n${html(progress.replace('SAVED CUTTING PROGRESS\n',''))}\n\n<i>Cutting progress is separate from shipping.</i>`]
 for(const group of pages(order.lineItems.nodes,6))messages.push(`${title} · <b>Items</b>\n\n${group.map(i=>`<b>${i.currentQuantity} × ${html(short(i.title,180))}</b>${i.variantTitle?`\n${html(short(i.variantTitle,100))}`:''}\nSKU: <code>${html(short(i.sku??'none',60))}</code>\n📤 ${i.unfulfilledQuantity} unfulfilled`).join('\n\n')}`)
 return messages
}
