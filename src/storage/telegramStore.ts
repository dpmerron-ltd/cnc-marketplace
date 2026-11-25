import { jobApiRequest } from './jobsApi'
export async function shareDailyPlan(owner:string,createdAt:string):Promise<{configured:boolean;sent:boolean}>{
 const response=await jobApiRequest('/telegram/day-plan',owner,{method:'POST',body:JSON.stringify({createdAt}),signal:AbortSignal.timeout(45000)})
 return response.json()
}
