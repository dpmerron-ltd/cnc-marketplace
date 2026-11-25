/** Estimated overall progress: stages have different costs, so this is not a time remaining estimate. */
export interface PlanningProgress {
  percent: number
  message: string
}
export type ReportPlanningProgress = (progress: PlanningProgress) => void
