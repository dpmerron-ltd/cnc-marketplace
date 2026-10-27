export const recutStatusNames = { queued: 'Waiting to re-cut', completed: 'Re-cut', cancelled: 'Removed' } as const
export type RecutStatus = keyof typeof recutStatusNames

export interface MachineRecut {
  id: string
  owner_id: string
  source_run_id: string
  sheet_index: number
  part_number: string
  part_name: string
  job_name: string
  order_number: string
  material: string
  thickness: string
  status: RecutStatus
  created_at: string
  updated_at: string
}

export function recutSourceLink(entry: MachineRecut): string {
  return `#machine/${entry.source_run_id}?sheet=${entry.sheet_index + 1}&part=${encodeURIComponent(entry.part_number)}`
}
