import { createClient } from '@supabase/supabase-js'
import { createApi, decodeBase64 } from './handler'
import { supabaseRepository } from './repository'

declare const __PDF_FONT_BASE64__: string
declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Promise<Response>): void }

const url = Deno.env.get('SUPABASE_URL')
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured in the backend environment.')
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
Deno.serve(createApi(supabaseRepository(db), decodeBase64(__PDF_FONT_BASE64__)))
