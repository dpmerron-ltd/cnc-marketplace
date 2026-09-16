import { createClient } from '@supabase/supabase-js'

const defaultSupabaseUrl = 'https://bsnndtwbvgrthddmbhoa.supabase.co'
const defaultSupabasePublishableKey = 'sb_publishable_egRTyMHTjgL0FdERPshDtg_hV9Hz7vc'

function envOrDefault(value: string | undefined, fallback: string): string {
  return value && value.trim().length > 0 ? value : fallback
}

export const supabaseUrl = envOrDefault(import.meta.env.VITE_SUPABASE_URL as string | undefined, defaultSupabaseUrl)
const supabasePublishableKey = envOrDefault(
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined,
  defaultSupabasePublishableKey,
)

export const isSupabaseConfigured = Boolean(supabaseUrl && supabasePublishableKey)

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl!, supabasePublishableKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
    })
  : undefined
