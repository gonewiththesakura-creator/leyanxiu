// Local verification only: in-memory database, simulated device proof and SMS.
// No .env loading, external requests, real users or merchant operations.
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {BILLING_SCHEMA} from '../server/payments/database.js';
import {createPaymentAccounts} from '../server/payments/accounts.js';
import {createBillingLedger} from '../server/payments/ledger.js';
import {createAccountRegistry} from '../server/accounts/registry.js';
import {registerAppAccountRoutes} from '../server/accounts/routes.js';
import {accountSessionGuard} from '../server/accounts/middleware.js';
const require=createRequire(new URL('../server/package.json',import.meta.url));
const {PGlite}=require('@electric-sql/pglite');const {Hono}=require('hono');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pg=new PGlite();await pg.exec(BILLING_SCHEMA);
const db={query:(...args)=>pg.query(...args),transaction:(_key,fn)=>pg.transaction(fn)};
const people=new Map(),subjects=new Map(),sessions=new Map();let offset=0,lastCode='';
const now=()=>Date.now()+offset;
const users={getUser:id=>people.get(id),revokeUserSessions:id=>{for(const [token,auth] of sessions)if(auth.userId===id)sessions.delete(token);},createOrGetUser:({subject})=>{
  if(subjects.has(subject))return people.get(subjects.get(subject));
  const user={id:`fixture-${crypto.randomUUID()}`,status:'active'};people.set(user.id,user);subjects.set(subject,user.id);return user;
}};
const registry=createAccountRegistry(db,{users,now});
const otp=createPaymentAccounts(db,{secret:'fixture-only-secret-not-for-production',now,sendSms:async(_phone,code)=>{lastCode=code;},resolveLogin:(...args)=>registry.phoneLogin(...args)});
const seeded=await otp.challenge({phone:'13800000000',purpose:'login',deviceUserId:'seed',ip:'seed'});
const paid=await otp.verify({...seeded,deviceUserId:'seed',code:lastCode});
const ledger=createBillingLedger(db,{now});
const {order}=await ledger.createOrder({userId:paid.userId,productId:'fixture',amountFen:100,credits:3,idempotencyKey:'fixture-order',channel:'android',productSnapshot:{id:'fixture',name:'测试套餐',amountFen:100,credits:3,type:'credits'}});
await ledger.applyPaymentEvent({orderId:order.id,status:'paid',providerTradeId:'fixture-trade',eventId:'fixture-event'});
offset+=61000;lastCode='';
const app=new Hono();
const sessionForUser=(userId,metadata)=>{const token=crypto.randomUUID();sessions.set(token,{userId,...metadata});return {token,user:{id:userId}};};
const getAuth=c=>sessions.get(c.req.header('Authorization')?.replace(/^Bearer /,''));
const authenticated=c=>{const auth=getAuth(c);return auth?{auth}:{response:c.json({code:'AUTH_REQUIRED'},401)};};
app.post('/api/auth/session',async c=>{
  const body=await c.req.json();const guest=users.createOrGetUser({subject:`fixture-device:${body.clientId}`});
  const binding=await registry.device(guest.id);
  return c.json({code:0,data:sessionForUser(binding.userId,{...binding,authMethod:binding.deviceVersion?'account-device':'device_bootstrap'})});
});
app.use('/api/*',accountSessionGuard({registry,getAuth}));
app.get('/api/account/payment-identity',async c=>{const {auth,response}=authenticated(c);return response || c.json({code:0,data:{...await registry.status(auth.userId),available:true,loginEnabled:true,wechatAvailable:false}});});
app.get('/api/account/entitlements',async c=>{const {auth,response}=authenticated(c);return response || c.json({code:0,data:await ledger.entitlements(auth.userId)});});
registerAppAccountRoutes(app,{registry,otp,users,authenticated,sessionForUser,flush:async()=>{},clientAddress:()=> 'fixture-browser',smsReady:()=>true,wechatReady:()=>false,rateLimit:()=>true});
app.get('/fixture/code',c=>c.json({code:lastCode}));
app.post('/fixture/advance',c=>{offset+=61000;return c.json({ok:true});});
const vite=await createServer({root,configFile:false,envFile:false,plugins:[react(),{name:'account-fixture',configureServer(server){server.middlewares.use(async(req,res,next)=>{
  if(!req.url?.startsWith('/api/') && !req.url?.startsWith('/fixture/'))return next();
  try {
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const response=await app.request(new Request(`http://127.0.0.1:5198${req.url}`,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})}));
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500);res.end('Fixture failure');}
});}}],resolve:{alias:{'@':path.join(root,'src')}},define:{'import.meta.env.VITE_API_BASE':JSON.stringify(''),'import.meta.env.VITE_USER_AGREEMENT_URL':JSON.stringify('https://example.invalid/terms'),'import.meta.env.VITE_PRIVACY_POLICY_URL':JSON.stringify('https://example.invalid/privacy'),'import.meta.env.VITE_CLOSED_TEST_INVITE_REQUIRED':JSON.stringify('false'),'import.meta.env.VITE_USE_MOCK':JSON.stringify('false')},server:{host:'127.0.0.1',port:5198,strictPort:true}});
await vite.listen();console.log('Isolated account fixture: http://127.0.0.1:5198/scripts/account-preview.html');
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await vite.close();await pg.close();process.exit(0);});
