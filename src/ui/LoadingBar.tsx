export function LoadingBar({label,percent}:{label:string;percent?:number}) {
 const value=percent!==undefined&&Number.isFinite(percent)?Math.min(100,Math.max(0,percent)):undefined
 return <div className="day-planning-progress" aria-busy="true"><span>{label}{value!==undefined?` ${Math.round(value)}%`:''}</span><progress aria-label={label} max={100} value={value} style={{width:'100%'}} /></div>
}
