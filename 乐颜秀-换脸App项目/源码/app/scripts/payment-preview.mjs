import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const products=[{id:'fixture-pack',name:'次数包（验收示例）',amountFen:990,credits:10,type:'credits'},{id:'fixture-month',name:'30 天套餐（验收示例）',amountFen:4990,credits:60,type:'monthly',durationDays:30}];
const orders=[{id:'fixture-order-1',productId:products[1].id,productSnapshot:products[1],userId:'fixture-user',amountFen:4990,credits:60,status:'paid',createdAt:'2026-09-27T01:00:00Z',fulfilledAt:'2026-09-27T01:00:00Z',startsAt:'2026-09-27T01:00:00Z',expiresAt:'2026-10-27T01:00:00Z'}];
let bound=false;const refunds=[];
let server;
const fixtureMiddleware=async(req,res,next)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname==='/') {
    res.setHeader('Content-Type','text/html;charset=utf-8');
    res.end(await server.transformIndexHtml(req.url,'<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"/><title>支付页面本地验收</title></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/payment-preview.tsx"></script></body></html>'));return;
  }
  if(!url.pathname.startsWith('/api/'))return next();
  let data={};let code=0;
  if(url.pathname==='/api/auth/session')data={token:'fixture-only'};
  else if(url.pathname==='/api/products')data={available:false,mode:'closed_test',products};
  else if(url.pathname==='/api/orders')data=orders;
  else if(url.pathname==='/api/refunds')data=refunds;
  else if(url.pathname==='/api/account/entitlements')data={totalRemaining:48};
  else if(url.pathname==='/api/account/payment-identity')data={userId:'fixture-user',available:true,bound,maskedPhone:bound?'138****0000':null};
  else if(url.pathname==='/api/account/phone/challenge')data={challengeId:'fixture',expiresIn:300};
  else if(url.pathname==='/api/account/phone/verify'){bound=true;data={token:'fixture-recovered'};}
  else if(url.pathname.endsWith('/refund-quote'))data={amountFen:3992,credits:48};
  else if(url.pathname.endsWith('/refund')){const refund={id:'fixture-refund',orderId:orders[0].id,amountFen:3992,credits:48,status:'requested'};refunds.push(refund);data={refund};}
  else if(url.pathname==='/api/admin/billing')data={readiness:{ready:false,mode:'closed_test',blockers:['本地页面验收，未连接商户']},operationsReadiness:{ready:false,blockers:['本地页面验收']},orders,refunds,reconciliation:{ok:true,users:1,mismatches:[]},products,dailyBills:[]};
  else {code='FIXTURE_UNSUPPORTED';res.statusCode=404;}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code,data}));
};
server=await createServer({root,configFile:false,envFile:false,plugins:[react(),{name:'payment-fixtures',configureServer(instance){instance.middlewares.use(fixtureMiddleware);}}],resolve:{alias:{'@':path.join(root,'src')}},
  define:{'import.meta.env.VITE_API_BASE':'""','import.meta.env.VITE_USE_MOCK':'"false"','import.meta.env.VITE_CLOSED_TEST_INVITE_REQUIRED':'"false"'},server:{host:'127.0.0.1',port:5197,strictPort:true}});
await server.listen();console.log('Local fixture UI only: http://127.0.0.1:5197/ (no merchant, no SMS, no real database)');
