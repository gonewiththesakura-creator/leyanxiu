import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {request} from './inspect-app-ecs.mjs';
import {DEFAULT_CATALOG} from '../catalog-defaults.js';
const server=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const instance='REDACTED_COMPANY_CLOUD_INSTANCE';
const target='/opt/leyanxiu-app-account';
const report=value=>console.log(JSON.stringify(value));
try {
  const action=process.argv[2]||'plan';
  if(action==='status') {
    const id=process.argv[3];if(!/^t-[a-zA-Z0-9]+$/.test(id))throw new Error('INVALID_ID');
    const r=await request('DescribeInvocationResults',{InvokeId:id,InstanceId:instance,ContentEncoding:'PlainText'});
    report({results:r.Invocation?.InvocationResults?.InvocationResult?.map(v=>({status:v.InvocationStatus,exitCode:v.ExitCode,output:v.Output}))});
  } else if(action==='plan'||action==='upload') {
    const files={};
    for(const item of fs.readdirSync(server,{withFileTypes:true})) {
      if(item.isFile()&&((item.name.endsWith('.js')&&!/^(test|compare|upload|add|generate|_)/.test(item.name))||['package.json','package-lock.json'].includes(item.name)))files[item.name]=fs.readFileSync(path.join(server,item.name)).toString('base64');
    }
    function collect(dir){for(const e of fs.readdirSync(path.join(server,dir),{withFileTypes:true})){const n=dir+'/'+e.name;if(e.isDirectory())collect(n);else if(e.isFile()&&/\.(js|json)$/.test(e.name))files[n]=fs.readFileSync(path.join(server,n)).toString('base64');}}
    for(const d of ['accounts','payments','providers'])collect(d);
    for(const f of ['scripts/app-billing-migrate.mjs','deploy/install-app-account.sh','deploy/leyanxiu-app-account.service'])files[f]=fs.readFileSync(path.join(server,f)).toString('base64');
    files['testpage.html']=Buffer.from('<!doctype html><meta charset="utf-8"><title>乐颜秀 App 账号联调</title><p>App 账号测试 API；未开放短信、付款与公网访问。</p>').toString('base64');
    const bytes=zlib.gzipSync(JSON.stringify(files));const hash=crypto.createHash('sha256').update(bytes).digest('hex');
    report({files:Object.keys(files).length,bytes:bytes.length,sha256:hash,containsEnv:false,containsUserData:false,apiOnly:true});
    if(action==='upload'){
      const parts=[];
      for(let offset=0;offset<bytes.length;offset+=24000){const name=`part-${String(parts.length).padStart(3,'0')}`;const result=await request('SendFile',{'InstanceId.1':instance,Name:name,TargetDir:target+'/incoming-20260930',ContentType:'Base64',Content:bytes.subarray(offset,offset+24000).toString('base64'),FileMode:'600',Overwrite:'false'});parts.push({name,invokeId:result.InvokeId});}
      report({parts});
      const script=`set -eu\npython3 - <<'PY'\nimport pathlib,hashlib,gzip,json,base64\nb=pathlib.Path('${target}/incoming-20260930')\nfiles=sorted(b.glob('part-*'))\nassert len(files)==${parts.length}\ndata=b''.join(p.read_bytes() for p in files)\nassert hashlib.sha256(data).hexdigest()=='${hash}'\nr=pathlib.Path('${target}/releases/20260930-account')\nr.mkdir(parents=True,exist_ok=False)\nfor name,value in json.loads(gzip.decompress(data)).items():\n p=r/name\n assert p.resolve().is_relative_to(r.resolve())\n p.parent.mkdir(parents=True,exist_ok=True)\n p.write_bytes(base64.b64decode(value))\nprint('APP_SOURCE_HASH_VERIFIED')\nPY\n`;
      const run=await request('RunCommand',{'InstanceId.1':instance,Type:'RunShellScript',Name:'leyanxiu-app-source-20260930',CommandContent:Buffer.from(script).toString('base64'),ContentEncoding:'Base64',Timeout:'60',KeepCommand:'false'});report({assemblyId:run.InvokeId});
    }
  } else if(action==='assets') {
    const assets=[...new Set([...DEFAULT_CATALOG.templates.flatMap(t=>[t.cover,t.previewVideo].filter(Boolean)),...DEFAULT_CATALOG.photoCategories.map(t=>t.cover),...DEFAULT_CATALOG.photoEffects.map(t=>t.preview).filter(Boolean)])];
    const files=Object.fromEntries(assets.map(name=>[name.slice(1),fs.readFileSync(path.join(server,'../public',name)).toString('base64')]));
    const bytes=zlib.gzipSync(JSON.stringify(files));const hash=crypto.createHash('sha256').update(bytes).digest('hex');
    const parts=Math.ceil(bytes.length/24000);report({assets:assets.length,bytes:bytes.length,parts,sha256:hash});
    for(let i=0;i<parts;i+=4) {
      const results=await Promise.allSettled(Array.from({length:Math.min(4,parts-i)},async(_,n)=>{const index=i+n;return request('SendFile',{'InstanceId.1':instance,Name:`part-${String(index).padStart(4,'0')}`,TargetDir:target+'/assets-incoming-20260930',ContentType:'Base64',Content:bytes.subarray(index*24000,(index+1)*24000).toString('base64'),FileMode:'600',Overwrite:'false'});}));
      if(results.some(r=>r.status==='rejected'))throw new Error('ASSET_TRANSFER_INCOMPLETE');
      if(i%40===0)report({partsSent:Math.min(i+4,parts),total:parts});
    }
    const script=`set -eu\npython3 - <<'PY'\nimport pathlib,hashlib,gzip,json,base64\nb=pathlib.Path('${target}/assets-incoming-20260930')\nparts=sorted(b.glob('part-*'))\nassert len(parts)==${parts}\ndata=b''.join(p.read_bytes() for p in parts)\nassert hashlib.sha256(data).hexdigest()=='${hash}'\nr=pathlib.Path('${target}/releases/20260930-account/web')\nr.mkdir(exist_ok=False)\nfor name,value in json.loads(gzip.decompress(data)).items():\n p=r/name\n assert p.resolve().is_relative_to(r.resolve())\n p.parent.mkdir(parents=True,exist_ok=True)\n p.write_bytes(base64.b64decode(value))\nprint('APP_ASSETS_HASH_VERIFIED')\nPY\n`;
    const r=await request('RunCommand',{'InstanceId.1':instance,Type:'RunShellScript',Name:'leyanxiu-app-assets-20260930',CommandContent:Buffer.from(script).toString('base64'),ContentEncoding:'Base64',Timeout:'60',KeepCommand:'false'});report({assetsInstallId:r.InvokeId});
  } else if(action==='install') {
    const run=await request('RunCommand',{'InstanceId.1':instance,Type:'RunShellScript',Name:'leyanxiu-app-private-install-20260930',CommandContent:Buffer.from(`bash ${target}/releases/20260930-account/deploy/install-app-account.sh`).toString('base64'),ContentEncoding:'Base64',Timeout:'1800',KeepCommand:'false'});report({installId:run.InvokeId});
  } else throw new Error('INVALID_ACTION');
}catch(e){report({error:/^[A-Za-z0-9_.-]+$/.test(e.message)?e.message:'APP_ECS_OPERATION_UNCONFIRMED'});process.exitCode=1;}
