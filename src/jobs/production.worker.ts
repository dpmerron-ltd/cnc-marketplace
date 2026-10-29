import { replanWorkspace } from './production'
self.onmessage = event => {
  try { self.postMessage({ workspace: replanWorkspace(event.data.workspace, event.data.parts) }) }
  catch (error) { self.postMessage({ error: (error as Error).message }) }
}
