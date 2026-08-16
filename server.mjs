import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const ATTIO_TOKEN = process.env.ATTIO_TOKEN || "";
const BRAVE_API_KEY = process.env.BRAVE_API_KEY || "";
const ATTIO_API = "https://api.attio.com/v2";
const cacheFile = path.join(__dirname, "data", "scan-cache.json");

function send(res, code, body, type="application/json"){
  res.writeHead(code, {"content-type":type,"cache-control":"no-store"});
  res.end(type.includes("json") ? JSON.stringify(body) : body);
}
function readCache(){ try{return JSON.parse(fs.readFileSync(cacheFile,"utf8"))}catch{return {}} }
function writeCache(x){ try{fs.writeFileSync(cacheFile, JSON.stringify(x,null,2))}catch{} }

async function attio(url, opts={}){
  if(!ATTIO_TOKEN) throw new Error("ATTIO_TOKEN is not configured.");
  const r = await fetch(ATTIO_API+url,{
    ...opts,
    headers:{"Authorization":`Bearer ${ATTIO_TOKEN}`,"Content-Type":"application/json",...(opts.headers||{})}
  });
  const text=await r.text(); let j; try{j=JSON.parse(text)}catch{j={message:text}}
  if(!r.ok) throw new Error(j?.message || `Attio error ${r.status}`);
  return j;
}
function valText(v){
  if(v==null)return "";
  if(typeof v==="string"||typeof v==="number"||typeof v==="boolean")return String(v);
  if(Array.isArray(v))return v.map(valText).filter(Boolean).join(" | ");
  for(const k of ["value","full_name","name","domain","root_domain","email_address","phone_number","original_phone_number","option","title"]){
    if(v[k]!=null){const t=valText(v[k]); if(t)return t}
  }
  return Object.values(v).map(valText).filter(Boolean).join(" | ");
}
function flatten(values={}){
  const o={}; for(const [k,v] of Object.entries(values))o[k]=valText(v); return o;
}
function pick(flat, regexes){
  for(const re of regexes){const k=Object.keys(flat).find(x=>re.test(x)); if(k&&flat[k])return flat[k].split(" | ")[0]}
  return "";
}
async function allCompanies(){
  let out=[],offset=0;
  while(true){
    const j=await attio("/objects/companies/records/query",{method:"POST",body:JSON.stringify({limit:500,offset})});
    const rows=j.data||[]; out.push(...rows);
    if(rows.length<500)break; offset+=rows.length; if(offset>10000)break;
  }
  return out.map(r=>{
    const f=flatten(r.values);
    return {
      id:r?.id?.record_id||"",
      name:pick(f,[/^name$/i,/company.?name/i])||"Unnamed company",
      domain:pick(f,[/^domains?$/i,/website/i,/domain/i]),
      phone:pick(f,[/phone/i,/mobile/i,/telephone/i]),
      location:pick(f,[/city/i,/location/i,/address/i,/postcode/i,/region/i]),
      attioUrl:r.web_url||""
    };
  });
}
async function brave(q,count=10){
  if(!BRAVE_API_KEY) throw new Error("BRAVE_API_KEY is not configured.");
  const u=new URL("https://api.search.brave.com/res/v1/web/search");
  u.searchParams.set("q",q);u.searchParams.set("count",String(Math.min(count,20)));
  u.searchParams.set("country","GB");u.searchParams.set("search_lang","en");
  const r=await fetch(u,{headers:{"Accept":"application/json","X-Subscription-Token":BRAVE_API_KEY}});
  const text=await r.text();let j;try{j=JSON.parse(text)}catch{j={}}
  if(!r.ok)throw new Error(j?.message||`Search error ${r.status}`);
  return (j?.web?.results||[]).map(x=>({title:x.title||"",url:x.url||"",description:x.description||"",age:x.age||""}));
}
const rx = {
  fixed:/\b(fixed wire|fixed wiring|fixed electrical|eicr|electrical installation condition report|periodic electrical inspection|periodic inspection(?: and testing)?|electrical inspection and testing)\b/i,
  tender:/\b(tender|contract award|award notice|procurement|framework|contract notice|supplier|successful bidder)\b/i,
  due:/\b(due|overdue|expiry|expires|expiring|renewal|renew|end date|contract end|completion date)\b/i,
  cycle:/\b(annual|annually|1 year|one year|3 year|three year|5 year|five year|triennial|quinquennial)\b/i
};
function classifyResult(r){
  const text=`${r.title}\n${r.description}`;
  const flags={fixed:rx.fixed.test(text),tender:rx.tender.test(text),due:rx.due.test(text),cycle:rx.cycle.test(text)};
  let evidenceScore=(flags.fixed?40:0)+(flags.tender?15:0)+(flags.due?20:0)+(flags.cycle?15:0);
  if(/contractsfinder\.service\.gov\.uk|find-tender\.service\.gov\.uk|\.gov\.uk/i.test(r.url))evidenceScore+=10;
  return {...r,flags,evidenceScore:Math.min(100,evidenceScore)};
}
function inferOpportunity(results){
  const relevant=results.filter(x=>x.flags.fixed);
  if(!relevant.length)return {confidence:"NO EVIDENCE",score:0,reason:"No public fixed-wire/EICR evidence found.",evidence:[]};
  let score=Math.max(...relevant.map(x=>x.evidenceScore));
  let confidence="POSSIBLE",reason="Public evidence mentions fixed-wire/EICR activity.";
  if(relevant.some(x=>x.flags.fixed&&x.flags.due)){confidence="CONFIRMED";score=Math.max(score,85);reason="Public evidence explicitly combines fixed-wire/EICR with due, expiry or renewal language."}
  else if(relevant.some(x=>x.flags.fixed&&(x.flags.tender||x.flags.cycle))){confidence="LIKELY";score=Math.max(score,65);reason="Strong procurement or testing-cycle evidence found."}
  return {confidence,score,reason,evidence:relevant.sort((a,b)=>b.evidenceScore-a.evidenceScore).slice(0,6)};
}
async function scanCompany(company, force=false){
  const cache=readCache(),key=company.id||company.name;
  if(!force && cache[key] && Date.now()-new Date(cache[key].scannedAt).getTime()<7*86400000) return cache[key];
  const n=`"${company.name.replace(/"/g,"")}"`;
  const queries=[
    `${n} ("fixed wire" OR "fixed wiring" OR EICR)`,
    `${n} ("electrical inspection" OR "periodic inspection") (contract OR tender OR due OR expiry)`,
    `${n} (EICR OR "fixed wire") (tender OR contract OR procurement)`,
    `${n} filetype:pdf (EICR OR "fixed wire" OR "electrical inspection")`
  ];
  let batches=[];
  for(const q of queries){ try{batches.push(...await brave(q,8))}catch{} }
  const seen=new Set(),unique=batches.filter(x=>x.url&&!seen.has(x.url)&&seen.add(x.url)).map(classifyResult);
  const opp=inferOpportunity(unique);
  const result={company,...opp,queries,scannedAt:new Date().toISOString()};
  cache[key]=result;writeCache(cache);return result;
}

const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,`http://${req.headers.host}`);
    if(u.pathname==="/api/health")return send(res,200,{ok:true,attio:!!ATTIO_TOKEN,search:!!BRAVE_API_KEY});
    if(u.pathname==="/api/companies")return send(res,200,{data:await allCompanies()});
    if(u.pathname==="/api/cache")return send(res,200,{data:Object.values(readCache())});
    if(u.pathname==="/api/scan"&&req.method==="POST"){
      let body="";for await(const c of req)body+=c;const p=JSON.parse(body||"{}");
      return send(res,200,{data:await scanCompany(p.company,!!p.force)});
    }
    const rel=u.pathname==="/" ? "/index.html":u.pathname;
    const file=path.join(__dirname,"public",rel);
    if(!file.startsWith(path.join(__dirname,"public"))||!fs.existsSync(file))return send(res,404,{error:"Not found"});
    const ext=path.extname(file),type={".html":"text/html; charset=utf-8"}[ext]||"application/octet-stream";
    return send(res,200,fs.readFileSync(file),type);
  }catch(e){return send(res,500,{error:e.message})}
});
server.listen(PORT,()=>console.log(`Fixed Wire Radar running on port ${PORT}`));
