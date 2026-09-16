import { supabase, supabaseUrl } from './supabaseClient'

export const jobsApiUrl = `${supabaseUrl}/functions/v1/cnc-api/v1`

export async function jobApiRequest(path: string, userId: string, options: RequestInit = {}) {
  if (!supabase) throw new Error('Supabase is not configured.')
  const { data } = await supabase.auth.getSession()
  if (!data.session || data.session.user.id !== userId) throw new Error('The signed-in account changed. Reload the queue.')
  const response = await fetch(`${jobsApiUrl}${path}`, { ...options, headers: { ...options.headers, Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' } })
  if (!response.ok) {
    const error = await response.json().catch(() => ({}))
    throw new Error(error.error ?? error.message ?? `API request failed (${response.status}).`)
  }
  return response
}

export async function downloadJobFile(jobId: string, filename: string, userId: string, signal: AbortSignal) {
  const response = await jobApiRequest(`/jobs/${jobId}/artifacts/${encodeURIComponent(filename)}`, userId, { signal })
  const blob = await response.blob()
  if (signal.aborted) return
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `${jobId.slice(0, 8)}-${filename}`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
