import http from 'node:http';
const routes=[['/auth/v1',54432],['/rest/v1',54431],['/storage/v1',54433]];
http.createServer((req,res)=>{
 const cors={'Access-Control-Allow-Origin':'http://localhost:3020','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info,x-supabase-api-version,x-upsert,cache-control','Access-Control-Allow-Methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS','Access-Control-Allow-Credentials':'true'};
 if(req.method==='OPTIONS'){
  // Supabase SDK versions add client metadata headers. Reflect requested header
  // names only for the explicitly allowed local frontend origin.
  if(req.headers.origin==='http://localhost:3020' && req.headers['access-control-request-headers'])
    cors['Access-Control-Allow-Headers']=String(req.headers['access-control-request-headers']);
  res.writeHead(204,cors);res.end();return;
 }
 const route=routes.find(([prefix])=>req.url===prefix||req.url.startsWith(prefix+'/')||req.url.startsWith(prefix+'?'));
 if(!route){res.writeHead(404,cors);res.end();return;}
 const upstream=http.request({hostname:'127.0.0.1',port:route[1],method:req.method,path:req.url.slice(route[0].length)||'/',headers:{...req.headers,host:`127.0.0.1:${route[1]}`}},reply=>{
  const upstreamHeaders=Object.fromEntries(Object.entries(reply.headers).filter(([name])=>!name.toLowerCase().startsWith('access-control-')));
  res.writeHead(reply.statusCode,{...upstreamHeaders,...cors});reply.pipe(res);
 });
 upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502,cors);res.end('Local replica service unavailable');});
 req.pipe(upstream);
}).listen(54421,'127.0.0.1',()=>console.log('Local replica gateway: http://127.0.0.1:54421'));
