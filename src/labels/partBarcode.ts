import QRCode from 'qrcode'
export function partBarcodeUrl(id: string): string | undefined {
  // Legacy machine exports sometimes synthesized sheet-local IDs. Never present
  // those as globally unique physical-part identities.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return undefined
  return `https://t.me/tripleeightgroup_bot?start=part_${id.toLowerCase()}`
}
export function partBarcode(id: string) { const url=partBarcodeUrl(id);return url?QRCode.create(url,{errorCorrectionLevel:'M'}).modules:undefined }
export function drawPartBarcode(ctx: CanvasRenderingContext2D, id: string, x: number, y: number, size: number) {
 const code=partBarcode(id);if(!code)return
 const unit=size/(code.size+8)
 ctx.fillStyle='#fff';ctx.fillRect(x,y,size,size);ctx.fillStyle='#000'
 for(let row=0;row<code.size;row++)for(let col=0;col<code.size;col++)if(code.get(row,col))ctx.fillRect(x+(col+4)*unit,y+(row+4)*unit,unit,unit)
}
