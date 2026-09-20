/** Authenticated, resumable public Facebook-page collection for sister apps.
 * Mounted only below searchOpsRouter's sister-key gate. Provider keys stay here.
 */
import { Router } from 'express';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const router = Router();
const root = resolve(process.env.DATA_DIR || './data');
mkdirSync(root, { recursive: true });
const db = new Database(resolve(root, 'facebook-page-jobs.sqlite'));
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_key TEXT NOT NULL,
 input TEXT NOT NULL, state TEXT NOT NULL, run_id TEXT, dataset_id TEXT,
 created_at TEXT NOT NULL, UNIQUE(owner,request_key))`);
const owner = (key: unknown) => createHash('sha256').update(String(key)).digest('hex');
async function upstream(path: string, body?: unknown) {
 const token = process.env.APIFY_API_TOKEN;
 if (!token) throw new Error('Page collector not configured');
 const r = await fetch(`https://api.apify.com/v2${path}`, {method: body ? 'POST':'GET',
  headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
  ...(body ? {body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(45000)});
 if (!r.ok) throw new Error(`Page collector HTTP ${r.status}`);
 return r.json() as Promise<any>;
}
router.post('/jobs', async (req,res) => {
 const {requestKey, urls, from, to} = req.body || {};
 const lo=Date.parse(from), hi=Date.parse(to);
 if(typeof requestKey!=='string'||! /^[a-zA-Z0-9:_-]{1,100}$/.test(requestKey)||
  !Array.isArray(urls)||urls.length<1||urls.length>100||
  !Number.isFinite(lo)||!Number.isFinite(hi)||hi<=lo||hi-lo>48*3600000||
  urls.some((u: unknown)=>{try{const x=new URL(String(u));return x.protocol!=='https:'||!['facebook.com','www.facebook.com'].includes(x.hostname)||x.pathname==='/';}catch{return true;}})) {
  res.status(400).json({ok:false,error:'Need requestKey, 1–100 Facebook page URLs and a window no longer than 48 hours'});return;
 }
 const key=owner(req.headers['x-api-key']);
 const input=JSON.stringify({startUrls:urls.map((url:string)=>({url})),resultsLimit:100,
  onlyPostsNewerThan:new Date(lo).toISOString(),onlyPostsOlderThan:new Date(hi).toISOString()});
 const existing=db.prepare('SELECT * FROM jobs WHERE owner=? AND request_key=?').get(key,requestKey) as any;
 if(existing){
  if(existing.input!==input){res.status(409).json({ok:false,error:'Request key already used with different input'});return;}
  res.json({ok:true,jobId:existing.id,state:existing.state,runId:existing.run_id});return;
 }
 const id=randomUUID();
 db.prepare('INSERT INTO jobs(id,owner,request_key,input,state,created_at) VALUES(?,?,?,?,?,?)').run(id,key,requestKey,input,'submitting',new Date().toISOString());
 try {
  const result=await upstream('/acts/apify~facebook-posts-scraper/runs?timeout=900&memory=2048&maxTotalChargeUsd=8',JSON.parse(input));
  const run=result.data;
  db.prepare('UPDATE jobs SET state=?,run_id=?,dataset_id=? WHERE id=?').run(run.status,run.id,run.defaultDatasetId,id);
  res.status(202).json({ok:true,jobId:id,state:run.status,runId:run.id});
 } catch(error) {
  // Never silently resubmit after an ambiguous network outcome: that can double-charge.
  db.prepare('UPDATE jobs SET state=? WHERE id=?').run('submission-uncertain',id);
  res.status(502).json({ok:false,jobId:id,error:(error as Error).message,state:'submission-uncertain'});
 }
});
router.get('/jobs/:id', async(req,res)=>{
 const job=db.prepare('SELECT * FROM jobs WHERE id=? AND owner=?').get(req.params.id,owner(req.headers['x-api-key'])) as any;
 if(!job){res.status(404).json({ok:false,error:'Job not found'});return;}
 if(!job.run_id){res.json({ok:true,jobId:job.id,state:job.state});return;}
 try {
  const {data:run}=await upstream(`/actor-runs/${encodeURIComponent(job.run_id)}`);
  db.prepare('UPDATE jobs SET state=? WHERE id=?').run(run.status,job.id);
  const terminal=['SUCCEEDED','FAILED','TIMED-OUT','ABORTED'].includes(run.status);
  const items=terminal ? await upstream(`/datasets/${encodeURIComponent(job.dataset_id)}/items?format=json&limit=10000`) : undefined;
  res.json({ok:true,jobId:job.id,state:run.status,runId:run.id,items,stats:run.stats,usageTotalUsd:run.usageTotalUsd});
 } catch(error){res.status(502).json({ok:false,error:(error as Error).message});}
});
export default router;
