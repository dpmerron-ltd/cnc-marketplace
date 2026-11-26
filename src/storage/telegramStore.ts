import { jobApiRequest } from './jobsApi'
export async function shareDailyPlan(owner:string,createdAt:string):Promise<{configured:boolean;sent:boolean}>{
 const response=await jobApiRequest('/telegram/day-plan',owner,{method:'POST',body:JSON.stringify({createdAt}),signal:AbortSignal.timeout(45000)})
 return response.json()
}

export async function syncPacking(owner:string,orderIds:string[]):Promise<{results:Array<{id:string;name?:string;tagged:boolean;retry?:boolean;message:string}>}>{
 const response=await jobApiRequest('/shopify/packing-sync',owner,{method:'POST',body:JSON.stringify({orderIds}),signal:AbortSignal.timeout(90000)})
 return response.json()
}
