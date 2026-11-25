import { buildDailyPlan } from './dailyPlan'
self.onmessage = (event) => {
  try {
    self.postMessage({ workspace: buildDailyPlan(event.data, (progress) => self.postMessage({ progress })) })
  } catch (error) {
    self.postMessage({ error: (error as Error).message })
  }
}
