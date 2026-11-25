import { buildDailyPlan } from './dailyPlan'
self.onmessage = (event) => {
  try {
    self.postMessage({ workspace: buildDailyPlan(event.data) })
  } catch (error) {
    self.postMessage({ error: (error as Error).message })
  }
}
