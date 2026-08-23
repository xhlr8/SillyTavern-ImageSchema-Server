import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path'; import test from 'node:test'; import { exit, init } from '../index.mjs';
const PNG = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
class Router {
    constructor() { this.routes = []; }
    get(path, ...handlers) { this.routes.push({ method: 'GET', path, handlers }); }
    post(path, ...handlers) { this.routes.push({ method: 'POST', path, handlers }); }
    use() {}
    route(method, path) { return this.routes.find(item => item.method === method && item.path === path); }
}
const response = () => ({ statusCode:200, body:null, status(value){this.statusCode=value;return this;}, json(value){this.body=value;return value;} });
async function invoke(route,request){const reply=response();let error;const next=value=>{error=value;};for(const handler of route.handlers){await handler(request,reply,next);if(error)throw error;}return reply;}
const user=handle=>({profile:{handle,admin:false}}); const body={request:{text:'private prompt',params:{profile:'fixed',seed:7}},action:'resolve',chatId:'chat',messageId:'1',swipeKey:'0',slotId:'image'};
async function poll(route,handle,id){for(let i=0;i<500;i++){const job=(await invoke(route,{method:'GET',user:user(handle),params:{jobId:id}})).body;if(['completed','failed','cancelled'].includes(job.state))return job;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('job timeout');}
test('authenticated job API returns normal output and isolates users', async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'jobs-api-')); const config=path.join(root,'config.yaml'); const managed=path.join(root,'managed.json'); await writeFile(config,['defaultProfile: fixed','jobs:','  concurrency: 1','cache:','  enabled: false','outputs:','  enabled: true','  directory: '+JSON.stringify(path.join(root,'outputs')),'profiles:','  fixed:','    type: generic','    method: GET','    url: https://provider.test/image'].join('\n'));
 const oldConfig=process.env.SILLYTAVERN_IMAGE_CONFIG,oldManaged=process.env.SILLYTAVERN_IMAGE_MANAGED_CONFIG,oldFetch=globalThis.fetch; process.env.SILLYTAVERN_IMAGE_CONFIG=config;process.env.SILLYTAVERN_IMAGE_MANAGED_CONFIG=managed;globalThis.fetch=async()=>new Response(PNG,{status:200,headers:{'content-type':'image/png'}});
 t.after(async()=>{await exit();globalThis.fetch=oldFetch;if(oldConfig===undefined)delete process.env.SILLYTAVERN_IMAGE_CONFIG;else process.env.SILLYTAVERN_IMAGE_CONFIG=oldConfig;if(oldManaged===undefined)delete process.env.SILLYTAVERN_IMAGE_MANAGED_CONFIG;else process.env.SILLYTAVERN_IMAGE_MANAGED_CONFIG=oldManaged;await rm(root,{recursive:true,force:true});});
 const router=new Router();await init(router);const create=router.route('POST','/jobs'),get=router.route('GET','/jobs/:jobId'),list=router.route('GET','/jobs'); await assert.rejects(invoke(create,{method:'POST',body}),e=>e.status===401);const accepted=await invoke(create,{method:'POST',user:user('alice'),body});assert.equal(accepted.statusCode,202);assert.equal(Object.hasOwn(accepted.body,'request'),false);await assert.rejects(invoke(get,{method:'GET',user:user('bob'),params:{jobId:accepted.body.jobId}}),e=>e.status===404);const done=await poll(get,'alice',accepted.body.jobId);assert.equal(done.state,'completed',JSON.stringify(done.error));assert.deepEqual(Object.keys(done.result).sort(),['metadata','outputId','outputUrl','requestKey'].sort());assert.equal(JSON.stringify(done).includes('private prompt'),false);assert.deepEqual((await invoke(list,{method:'GET',user:user('bob')})).body,{active:[],recent:[]});assert.equal((await invoke(list,{method:'GET',user:user('alice')})).body.recent[0].jobId,accepted.body.jobId);
});
