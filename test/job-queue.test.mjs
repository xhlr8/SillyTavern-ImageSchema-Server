import assert from 'node:assert/strict';
import test from 'node:test';
import { GenerationJobQueue } from '../jobs.mjs';
const input = seed => ({ chatId:'c', messageId:'m', swipeKey:'0', slotId:String(seed), action:'resolve', request:{ params:{ seed } } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(fn) { for (let i=0;i<200;i++) { const value=fn(); if(value)return value; await new Promise(setImmediate); } assert.fail('timed out'); }

test('FIFO ordering and configurable concurrency', async t => {
 const gates=new Map([1,2,3].map(x=>[x,deferred()])), started=[]; let running=0,max=0;
 const q=new GenerationJobQueue({concurrency:2,executor:async({request,updateState})=>{const s=request.params.seed;started.push(s);running++;max=Math.max(max,running);updateState('provider-running');await gates.get(s).promise;running--;return{s};}}); t.after(()=>q.close());
 const jobs=[1,2,3].map(x=>q.create('a',input(x))); await until(()=>started.length===2); assert.deepEqual(started,[1,2]); assert.equal(max,2); gates.get(1).resolve(); await until(()=>started.length===3); assert.deepEqual(started,[1,2,3]); gates.get(2).resolve();gates.get(3).resolve();await until(()=>jobs.every(j=>q.get('a',j.jobId)?.state==='completed'));
});

test('queued/running cancellation, isolation, failures, and retention', async t => {
 let signal; const q=new GenerationJobQueue({executor:({signal:s,updateState})=>new Promise((_r,reject)=>{signal=s;updateState('provider-running');s.addEventListener('abort',()=>reject(s.reason),{once:true});})}); t.after(()=>q.close());
 const active=q.create('alice',input(1)), queued=q.create('alice',input(2)); await until(()=>q.get('alice',active.jobId)?.state==='provider-running'); assert.equal(q.get('bob',active.jobId),null); assert.equal(q.cancel('bob',active.jobId),null); assert.equal(q.cancel('alice',queued.jobId).job.state,'cancelled'); assert.equal(q.cancel('alice',active.jobId).job.state,'cancelled'); assert.equal(signal.aborted,true);
 let now=100; const failing=new GenerationJobQueue({now:()=>now,retentionMs:600000,executor:async()=>{throw new Error('secret raw error')}}); t.after(()=>failing.close()); const created=failing.create('alice',input(3)); const failed=await until(()=>{const j=failing.get('alice',created.jobId);return j?.state==='failed'?j:null}); assert.deepEqual(failed.error,{code:'generation_failed',message:'Generation job failed'}); now+=599999;assert.ok(failing.get('alice',created.jobId));now++;assert.equal(failing.get('alice',created.jobId),null);
});
