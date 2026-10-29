const { AUTHORIZATION } = require('./test-support/deployment-auth.cjs');
const { fixture, known } = require('./test-support/analysis-fixture.cjs');
const assert = require('node:assert/strict');
const test = require('node:test');
const { NextRequest } = require('next/server');
const { middleware } = require('../middleware.ts');
const { getApplicationAccessMode } = require('./deployment-policy.ts');
const { handleAnalyzeRequest } = require('./test-support/analyze-handler.cjs');
const { checkAnalyzeRateLimit, ATOMIC_DAILY_ANALYSIS_SCRIPT } = require('./analyze-rate-limit.ts');
const { dailyReply } = require('./test-support/daily-admission.cjs');
const { translate } = require('./i18n.ts');
async function env(changes, run) {
  const saved = Object.fromEntries(Object.keys(changes).map(k => [k, process.env[k]]));
  for (const [k,v] of Object.entries(changes)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await run(); } finally { for (const [k,v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const req = (headers = {}, language = 'en') => new Request('https://example.test/api/analyze', { method:'POST', headers:{'content-type':'application/json', ...headers}, body:JSON.stringify({...fixture({equity:known(1)}),language}) });
const review = { situationSummary: 'Synthetic.', mathematicalContext:{summary:'Synthetic.'}, streetAnalysis:{preflop:null,flop:null,turn:null,river:null},rangeAnalysis:{hero:'Known.',villain:'Known.',interaction:'Known.'},opponentAnalysis:'Unknown.',recommendedLine:{action:'Review',explanation:'Synthetic.'},keyTakeaways:['Synthetic.'],confidence:'low',missingInformation:[] };
for (const mode of [undefined,'private']) test(`private default remains protected: ${mode}`,()=>env({APPLICATION_ACCESS_MODE:mode},async()=>{
 assert.equal(getApplicationAccessMode(),'private');assert.equal((await middleware(new NextRequest('https://example.test'))).status,401);
 let calls=0;assert.equal((await handleAnalyzeRequest(req({'x-access-mode':'public','x-authenticated':'true'}),async()=>{calls++;return review;})).status,401);assert.equal(calls,0);
}));
for (const mode of ['', 'PUBLIC',' public','public ', 'invalid']) test(`invalid access configuration fails closed: ${JSON.stringify(mode)}`,()=>env({APPLICATION_ACCESS_MODE:mode},async()=>{
 assert.throws(()=>getApplicationAccessMode());const response=await middleware(new NextRequest('https://example.test'));assert.equal(response.status,503);assert.equal(response.headers.has('www-authenticate'),false);
 let calls=0;assert.equal((await handleAnalyzeRequest(req({authorization:AUTHORIZATION}),async()=>{calls++;return review;})).status,503);assert.equal(calls,0);
}));
test('public pages preserve fresh nonce CSP and no-store without Basic credentials',()=>env({APPLICATION_ACCESS_MODE:'public',DEPLOYMENT_ACCESS_SECRET:undefined},async()=>{
 const first=await middleware(new NextRequest('https://example.test'));const second=await middleware(new NextRequest('https://example.test'));
 assert.equal(first.status,200);assert.equal(first.headers.has('www-authenticate'),false);assert.match(first.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(first.headers.get('content-security-policy'),/nonce-/);assert.notEqual(first.headers.get('content-security-policy'),second.headers.get('content-security-policy'));assert.match(first.headers.get('cache-control'),/no-store/);assert.equal(first.headers.get('x-content-type-options'),'nosniff');
}));
test('public valid JSON dispatches without Basic and only with server verified math',()=>env({APPLICATION_ACCESS_MODE:'public',DEPLOYMENT_ACCESS_SECRET:undefined},async()=>{
 let providers=0, admissions=0;const response=await handleAnalyzeRequest(req(),async prompt=>{providers++;assert.match(prompt.user,/"value": 1/);return review;},async()=>{admissions++;return {status:'allowed'};});assert.equal(response.status,200);assert.equal(providers,1);assert.equal(admissions,1);
}));
for(const [headers,status] of [[{'content-type':'text/plain'},415],[{origin:'https://attacker.test'},403],[{'sec-fetch-site':'cross-site'},403]]) test(`public mode retains pre-admission protection ${status}`,()=>env({APPLICATION_ACCESS_MODE:'public'},async()=>{
 let calls=0;const fail=async()=>{calls++;throw new Error('must not run');};const response=await handleAnalyzeRequest(req(headers),fail,fail,{},fail);assert.equal(response.status,status);assert.equal(calls,0);
}));
for(const language of ['pl','en']) for(const scope of ['ip','global']) test(`localized daily quota ${scope}/${language}`,()=>env({APPLICATION_ACCESS_MODE:'public'},async()=>{
 let calls=0;const response=await handleAnalyzeRequest(req({},language),async()=>{calls++;return review;},async()=>({status:'limited',scope,retryAfterSeconds:60,resetAt:'2027-01-01T00:00:00.000Z'}));const body=await response.json();assert.equal(response.status,429);assert.equal(body.error,scope==='ip'?'ip_daily_limit_reached':'daily_limit_reached');assert.equal(body.message,translate(language,scope==='ip'?'errorIPDailyLimitReached':'errorDailyLimitReached'));assert.match(body.message,/00:00 UTC/);assert.equal(body.resetAt,'2027-01-01T00:00:00.000Z');assert.equal(response.headers.get('retry-after'),'60');assert.equal(calls,0);
}));
async function redis(run) {
 const original=global.fetch, previousNow=Date.now;const b={seconds:Math.floor(Date.UTC(2026,11,31,23,59,59)/1000),ips:new Map(),globals:new Map(),days:new Map(),calls:[]};
 global.fetch=async(_url,options)=>{const a=JSON.parse(options.body);assert.equal(a[1],ATOMIC_DAILY_ANALYSIS_SCRIPT);b.calls.push(a);return new Response(JSON.stringify({result:dailyReply(a,b.ips,b.globals,b.days,b.seconds)}));};
 Date.now=()=>Date.UTC(2040,5,1); // app clock disagreement must not choose the day
 try{return await env({NODE_ENV:'production',VERCEL:'1',VERCEL_ENV:'production',AI_CLIENT_IP_POLICY:'vercel',UPSTASH_REDIS_REST_URL:'https://redis.example.test',UPSTASH_REDIS_REST_TOKEN:'synthetic-test-only'},()=>run(b));}finally{global.fetch=original;Date.now=previousNow;}
}
const ipReq=ip=>new Request('https://example.test/api/analyze',{headers:{'x-vercel-forwarded-for':ip}});
test('per-IP daily quota does not reset after ten minutes; both reset at Redis UTC midnight despite app clock skew',()=>redis(async b=>{
 const r=ipReq('203.0.113.1');b.seconds-=3600;for(let i=0;i<5;i++)assert.equal((await checkAnalyzeRateLimit(r)).status,'allowed');b.seconds+=600;assert.equal((await checkAnalyzeRateLimit(r)).status,'limited');b.seconds+=3000;const blocked=await checkAnalyzeRateLimit(r);assert.equal(blocked.retryAfterSeconds,1);assert.equal(blocked.resetAt,'2027-01-01T00:00:00.000Z');b.seconds++;assert.equal((await checkAnalyzeRateLimit(r)).status,'allowed');assert.equal([...b.globals.values()][0],1);assert.equal([...b.ips.values()][0],1);
}));
test('parallel daily admission permits five per IP, exactly 100 globally and no increments on rejection',()=>redis(async b=>{
 const same=await Promise.all(Array.from({length:25},()=>checkAnalyzeRateLimit(ipReq('203.0.113.1'))));assert.equal(same.filter(v=>v.status==='allowed').length,5);assert.equal([...b.globals.values()][0],5);
 const others=await Promise.all(Array.from({length:130},(_,i)=>checkAnalyzeRateLimit(ipReq(`2001:db8::${(i+1).toString(16)}`))));assert.equal(others.filter(v=>v.status==='allowed').length,95);assert.equal([...b.globals.values()][0],100);assert.equal([...b.ips.values()].reduce((a,v)=>a+v,0),100);
 b.seconds++;assert.equal((await checkAnalyzeRateLimit(ipReq('203.0.113.1'))).status,'allowed');assert.equal([...b.globals.values()][0],1);
}));
test('public mode still fails closed on missing production Redis and trusted ingress',()=>env({APPLICATION_ACCESS_MODE:'public',NODE_ENV:'production',VERCEL:'1',VERCEL_ENV:'production',AI_CLIENT_IP_POLICY:'vercel',UPSTASH_REDIS_REST_URL:undefined,UPSTASH_REDIS_REST_TOKEN:undefined},async()=>{
 let calls=0;const actual=require('./analyze-handler.ts').handleAnalyzeRequest;assert.equal((await actual(req({'x-vercel-forwarded-for':'203.0.113.1'}),async()=>{calls++;return review;})).status,503);assert.equal(calls,0);
}));

for(const kind of ['partial','future-day','malformed-day','negative-count']) test(`malformed daily Redis state fails closed: ${kind}`,()=>redis(async b=>{
 const key='poker-analyze:daily:global:v2';b.globals.set(key,kind==='negative-count'?-1:1);
 if(kind!=='partial')b.days.set(key,kind==='future-day'?Math.floor(b.seconds/86400)+1:kind==='malformed-day'?'bad':Math.floor(b.seconds/86400));
 const result=await checkAnalyzeRateLimit(ipReq('203.0.113.1'));assert.equal(result.status,'unavailable');assert.equal(b.ips.size,0);
}));
