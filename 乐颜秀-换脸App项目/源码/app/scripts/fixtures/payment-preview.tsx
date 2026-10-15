import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { PurchaseView } from '../../src/views/Purchase';
import { BillingPanel } from '../../src/admin/BillingPanel';
import '../../src/index.css';
import '../../src/App.css';
import '../../src/admin/admin.css';
export function Preview(){const[credits,setCredits]=useState(0);return <><div style={{padding:10,background:'#fef3c7',color:'#78350f',fontSize:13}}>本地验收示例 · 无真实支付／短信 · 可用 {credits} 次</div>{location.search.includes('admin')?<div className="admin-app" style={{display:'block',padding:24}}><BillingPanel user={{username:'fixture',displayName:'验收',role:'owner'}}/></div>:<div style={{maxWidth:430,height:'calc(100vh - 40px)',margin:'auto'}}><PurchaseView onBack={()=>{}} onCredits={setCredits}/></div>}</>;}
createRoot(document.getElementById('root')!).render(<Preview/>);
