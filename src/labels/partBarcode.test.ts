// @vitest-environment node
import { expect, it } from 'vitest'
import jsQR from 'jsqr'
import { partBarcode, partBarcodeUrl } from './partBarcode'
it('round-trips a unique physical-part deep link through the QR matrix',()=>{
 const id='a72ac365-51c7-4aab-a674-2fa1caf874a6',code=partBarcode(id)!,scale=6,width=(code.size+8)*scale
 const pixels=new Uint8ClampedArray(width*width*4).fill(255)
 for(let row=0;row<code.size;row++)for(let col=0;col<code.size;col++)if(code.get(row,col))for(let dy=0;dy<scale;dy++)for(let dx=0;dx<scale;dx++){const p=(((row+4)*scale+dy)*width+(col+4)*scale+dx)*4;pixels[p]=pixels[p+1]=pixels[p+2]=0}
 expect(jsQR(pixels,width,width)?.data).toBe(partBarcodeUrl(id))
 expect(partBarcodeUrl(id)).not.toBe(partBarcodeUrl('b72ac365-51c7-4aab-a674-2fa1caf874a6'))
 expect(new URL(partBarcodeUrl(id)!).searchParams.get('start')!.length).toBeLessThanOrEqual(64)
})
it('does not invent global barcodes for old sheet-local IDs',()=>{expect(partBarcodeUrl('0-P001')).toBeUndefined()})
