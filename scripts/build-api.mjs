import { build } from 'esbuild'
import { readFile, mkdir } from 'node:fs/promises'

await mkdir('supabase/functions/cnc-api', { recursive: true })
const font = await readFile('api/assets/NotoSans-Regular.ttf')
await build({
  entryPoints: ['api/index.ts'], outfile: 'supabase/functions/cnc-api/index.ts',
  bundle: true, platform: 'neutral', format: 'esm', target: 'es2022', packages: 'external',
  banner: { js: '// @ts-nocheck\n// Generated from api/index.ts; source types are checked by npm run build:api.' },
  define: { __PDF_FONT_BASE64__: JSON.stringify(font.toString('base64')) },
})
