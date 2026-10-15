import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { officialCommand } from '../server/scripts/probe-mini-closed-client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.join(root, 'miniprogram');
const action = process.argv[2];
const page = process.argv[3] || 'featured';
const pages = new Set(['featured', 'home', 'songs', 'photos', 'mine']);
if (!pages.has(page)) throw new Error('Only public browsing pages are allowed in this visual check');
let tool, flags;
if (action === 'status') { tool = 'check_wechatide_status'; flags = ['--skill-version', '0.3.11']; }
else if (action === 'open') { tool = 'open_project_window'; flags = ['--project', project, '--windowMode', 'fullMode']; }
else if (action === 'compile') { tool = 'simulator_open_page'; flags = ['--project', project, '--page', `pages/${page}/index`]; }
else if (action === 'screenshot') {
  const directory = path.join(root, 'output/native-product-20261014');
  fs.mkdirSync(directory, { recursive: true });
  tool = 'simulator_screenshot'; flags = ['--project', project, '--path', path.join(directory, `${page}.png`), '--optimize', 'false', '--wait', '1'];
} else if (action === 'navigate') { tool = 'automation_navigate'; flags = ['--project', project, '--action', 'switchTab', '--url', `/pages/${page}/index`]; }
else if (action === 'runtime') { tool = 'automation_runtime_info'; flags = ['--project', project, '--action', 'currentPage']; }
else if (action === 'inspect') { tool = 'automation_evaluate'; flags = ['--project', project, '--fnSource', 'function(){var p=getCurrentPages().slice(-1)[0];var c=p.selectComponent("#featured-preview-"+p.data.current);return {route:p.route,visible:p.data.visible,current:p.data.current,mediaReady:p.data.mediaReady,previewFailed:p.data.previewFailed,previewError:p.data.previewDiagnostic,templates:p.data.templates?p.data.templates.length:undefined,category:p.data.categoryId,connected:p.data.connected,player:c?{live:c.live,active:c.properties.active,revision:c.revision,hasMedia:!!c.data.mediaSrc,src:c.properties.src}:null};}']; }
else if (action === 'preview-file-check') { tool = 'automation_evaluate'; flags = ['--project', project, '--fnSource', 'function(){var fs=wx.getFileSystemManager();return ["/preview-media/templates/dance-preview-r12.mp4","preview-media/templates/dance-preview-r12.mp4"].map(function(path){try{var bytes=fs.readFileSync(path);return {path:path,readable:true,length:bytes.byteLength};}catch(e){return {path:path,readable:false,error:String(e.message||e.errMsg).slice(0,180)};}});}']; }
else if (action === 'preview-markup') { tool = 'automation_element_action'; flags = ['--project', project, '--action', 'outerWxml', '--selector', '.feed']; }
else if (action === 'preview-play') { tool = 'automation_evaluate'; flags = ['--project', project, '--fnSource', 'function(){var p=getCurrentPages().slice(-1)[0];if(p.route!=="pages/featured/index")throw new Error("Preview page required");var c=p.selectComponent("#featured-preview-"+p.data.current);if(!c||!c.live||!c.properties.active)throw new Error("Visible preview required");wx.createVideoContext("preview",c).play();return {requested:true};}']; }
else throw new Error('Allowed commands: status/open/compile/screenshot/navigate/runtime/inspect');
const command = officialCommand(tool, flags);
try {
  const result = await promisify(execFile)(command.executable, command.args, command.options);
  const envelope = JSON.parse(result.stdout);
  if (action === 'status') {
    console.log(JSON.stringify({ ok: envelope.ok, loginExpired: envelope.result?.loginExpired,
      versionRelation: envelope.result?.versionRelation, tokenRequired: envelope.result?.cliTokenRequired }));
  } else console.log(JSON.stringify(envelope));
} catch (error) {
  console.error(JSON.stringify({ failed: action, timeout: error.killed === true, code: error.code }));
  if (error.stdout) console.log(error.stdout);
  process.exitCode = 1;
}
