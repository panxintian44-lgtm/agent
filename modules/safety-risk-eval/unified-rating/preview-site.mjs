import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createD1 } from "./site-fixture.mjs";
const root=path.resolve(process.argv[2]), DB=createD1(root);
const worker=(await import(pathToFileURL(path.join(root,"dist/server/index.js")).href)).default;
const server=http.createServer(async(req,res)=>{
  try {
    const body=[];for await(const chunk of req)body.push(chunk);
    const r=await worker.fetch(new Request("http://127.0.0.1:8789"+req.url,{method:req.method,headers:req.headers,...(body.length?{body:Buffer.concat(body)}:{})}),{DB});
    res.writeHead(r.status,Object.fromEntries(r.headers));res.end(Buffer.from(await r.arrayBuffer()));
  }catch {res.writeHead(503,{"Content-Type":"application/json"});res.end(JSON.stringify({error:{code:"LOCAL_PREVIEW_FAILED",message:"本地预览失败。"},execution_allowed:false}));}
});
server.listen(8789,"127.0.0.1",()=>console.log("Local synthetic preview: http://127.0.0.1:8789/risk"));
process.on("SIGINT",()=>server.close(()=>{DB.close();process.exit(0);}));
