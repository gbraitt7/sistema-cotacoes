import {env} from 'cloudflare:workers';
import {actor} from '../../../../server/invoice-auth';
import {problem} from '../../../../server/invoice-policy.js';
export const dynamic='force-dynamic';
const COLLECTIONS=['users','companies','suppliers','requests','equipment','items','quotes','operations','finance','billing','deliveries','history'];
const json=(value:any,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
const parse=(row:any)=>({...JSON.parse(row.data),_remoteVersion:row.version});
async function offloadFiles(data:any,bucket:any){if(!data||typeof data!=='object')return data;const seen=new Map<string,any>();const move=async(file:any)=>{if(!file||typeof file!=='object'||typeof file.dataUrl!=='string'||!file.dataUrl.startsWith('data:'))return file;const prior=seen.get(file.dataUrl);if(prior)return prior;const match=file.dataUrl.match(/^data:(application\/pdf|image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);if(!match)problem('Arquivo anexado inválido.');const bytes=Uint8Array.from(atob(match[2]),c=>c.charCodeAt(0));if(!bytes.length||bytes.length>1572864)problem('Cada arquivo deve ter até 1,5 MB.');const key=crypto.randomUUID();await bucket.put(key,bytes,{httpMetadata:{contentType:match[1]}});const result={...file,id:key,dataUrl:`/api/fretes/files/${key}`};seen.set(file.dataUrl,result);return result};if(Array.isArray(data.files))data.files=await Promise.all(data.files.map(move));if(Array.isArray(data.charges))for(const charge of data.charges)if(Array.isArray(charge.files))charge.files=await Promise.all(charge.files.map(move));return data;}
async function handle(req:Request){try{
 const user=await actor(),url=new URL(req.url),parts=url.pathname.replace(/^\/api\/fretes\/?/,'').split('/').filter(Boolean),[area,id]=parts,db=env.DB!,bucket=env.BUCKET!;
 if(req.method!=='GET'&&req.headers.get('Origin')!==url.origin)problem('Origem não autorizada.',403);
 if(area==='me'&&req.method==='GET')return json({id:user.id,name:user.name,email:user.email,role:user.role});
 if(area==='files'&&id&&req.method==='GET'){
  const row:any=await db.prepare("SELECT data,owner_id FROM freight_records WHERE collection='billing' AND data LIKE ? LIMIT 1").bind(`%${id}%`).first();
  if(!row||user.role==='Solicitante'&&row.owner_id!==user.id)problem('Arquivo não disponível para este perfil.',404);
  const object=await bucket.get(id);if(!object)problem('Arquivo não encontrado.',404);
  const data=JSON.parse(row.data),files=[...(data.files||[]),...(data.charges||[]).flatMap((c:any)=>c.files||[])],file=files.find((f:any)=>f.id===id||String(f.dataUrl||'').endsWith('/'+id)),name=String(file?.name||'anexo').replace(/[\r\n"\\]/g,'_');
  return new Response(object.body,{headers:{'Content-Type':object.httpMetadata?.contentType||'application/octet-stream','Content-Disposition':`attachment; filename="${name}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
 }
 if(area==='data'&&req.method==='GET'){
  if(!['Administrador','Logística','Solicitante','Financeiro'].includes(user.role))problem('Perfil sem acesso aos fretes.',403);
  const rows:any[]=(await db.prepare('SELECT collection,id,data,owner_id,updated_by,updated_at,version FROM freight_records').all()).results;
  let visible=rows;
  if(user.role==='Solicitante'){
   const own=new Set(rows.filter(r=>r.collection==='requests'&&(r.owner_id===user.id||JSON.parse(r.data).createdBy===user.id)).map(r=>r.id));
   const operations=new Map(rows.filter(r=>r.collection==='operations').map(r=>[r.id,JSON.parse(r.data).requestId]));
   visible=rows.filter(r=>r.collection==='requests'?own.has(r.id):own.has(JSON.parse(r.data).requestId)||r.collection==='finance'&&own.has(operations.get(JSON.parse(r.data).operationId)));
  }
  const collections:any={};for(const name of COLLECTIONS)collections[name]=visible.filter(r=>r.collection===name).map(parse);
  return json({collections});
 }
 if(area==='sync'&&req.method==='POST'){
  const raw=await req.text();if(raw.length>24_000_000)problem('Dados locais excedem o limite de sincronização.',413);const input=JSON.parse(raw),collections=input.collections||{};
  const ownRequests=new Set((collections.requests||[]).filter((r:any)=>user.role!=='Solicitante'||String(r.createdByName||'').trim().toLocaleLowerCase()===String(user.name||'').trim().toLocaleLowerCase()).map((r:any)=>r.id));
  const statements:any[]=[];let count=0;
  for(const name of COLLECTIONS){if(name==='users'||!Array.isArray(collections[name]))continue;for(const item of collections[name].slice(0,1000)){
   if(!item||typeof item.id!=='string'||item.id.length>150)continue;
   if(user.role==='Solicitante'&&name!=='requests'&&name!=='items'&&name!=='history')continue;
   if(user.role==='Solicitante'&&name==='requests'&&!ownRequests.has(item.id))continue;
   if(user.role==='Solicitante'&&['items','history'].includes(name)&&!ownRequests.has(item.requestId))continue;
   if(user.role==='Financeiro'&&name!=='finance')continue;
   const exists:any=await db.prepare('SELECT id,owner_id FROM freight_records WHERE collection=? AND id=?').bind(name,item.id).first();if(exists){if(user.role==='Solicitante'&&name==='requests'&&ownRequests.has(item.id)&&exists.owner_id!==user.id){const legacy={...item,createdBy:user.id,createdByName:user.name};delete (legacy as any)._remoteVersion;statements.push(db.prepare('UPDATE freight_records SET data=?,owner_id=?,updated_by=?,updated_at=?,version=version+1 WHERE collection=? AND id=? AND owner_id=?').bind(JSON.stringify(legacy),user.id,user.name,new Date().toISOString(),name,item.id,exists.owner_id));}continue;}
   let data={...item};delete (data as any)._remoteVersion;if(name==='billing')data=await offloadFiles(data,bucket);
   if(name==='requests'&&user.role==='Solicitante'){data={...data,createdBy:user.id,createdByName:user.name};}
   const owner=user.role==='Solicitante'?user.id:(name==='requests'&&typeof (data as any).createdBy==='string'?(data as any).createdBy:user.id);
   statements.push(db.prepare('INSERT OR IGNORE INTO freight_records(collection,id,data,owner_id,updated_by,updated_at,version) VALUES(?,?,?,?,?,?,1)').bind(name,item.id,JSON.stringify(data),owner,user.name,new Date().toISOString()));count++;
  }}
  for(let i=0;i<statements.length;i+=80)await db.batch(statements.slice(i,i+80));
  return json({ok:true,imported:count});
 }
 if(!COLLECTIONS.includes(area||''))problem('Área de fretes inválida.',404);
 if(req.method==='PUT'){
  if(id)problem('Caminho inválido.');
  if(area==='users')problem('Usuários são gerenciados pela área Acessos.',403);
  if(user.role==='Financeiro'&&area!=='finance')problem('Financeiro não pode alterar esta área.',403);
  if(user.role==='Solicitante'&&!['requests','items','history'].includes(area||''))problem('Solicitante só pode preencher os próprios rascunhos.',403);
  if(!['Administrador','Admin','Logística','Equipe Logística','Solicitante','Financeiro'].includes(user.role))problem('Perfil sem permissão para alterar fretes.',403);
  const raw=await req.text();if(raw.length>20_000_000)problem('Alteração excede o limite.',413);const input=JSON.parse(raw);if(!Array.isArray(input.rows)||input.rows.length>1000)problem('Lista de registros inválida.');
  const statements:any[]=[];
  for(const item of input.rows){if(!item||typeof item.id!=='string'||item.id.length>150)problem('Registro inválido.');const expectedVersion=item._remoteVersion;let data={...item};delete (data as any)._remoteVersion;if(area==='billing')data=await offloadFiles(data,bucket);
   const old:any=await db.prepare('SELECT data,owner_id FROM freight_records WHERE collection=? AND id=?').bind(area,item.id).first();
   let owner=old?.owner_id||user.id;
   if(user.role==='Solicitante'){
    if(area==='requests'){
     if(old&&old.owner_id!==user.id)problem('Solicitação não pertence a este usuário.',403);
     if(old&&JSON.parse(old.data).status!=='Rascunho')problem('Solicitação encaminhada deve ser atualizada pela Logística.',403);
     data={...data,createdBy:user.id,createdByName:user.name};owner=user.id;
    }else if(['items','history'].includes(area)){
     const parent:any=await db.prepare("SELECT owner_id,data FROM freight_records WHERE collection='requests' AND id=?").bind(data.requestId).first();
     if(!parent||parent.owner_id!==user.id||JSON.parse(parent.data).status!=='Rascunho')problem('Registro não pertence a um rascunho deste usuário.',403);owner=user.id;
    }else problem('Solicitante só pode preencher os próprios rascunhos.',403);
   }
   if(user.role==='Financeiro'&&area==='finance'&&!old)problem('Registro financeiro deve ser criado pela operação.',403);
   if(old){if(!Number.isInteger(expectedVersion)||expectedVersion!==old.version)problem('Este registro foi alterado por outra pessoa. Atualize a tela e reaplique sua alteração.',409);statements.push(db.prepare('UPDATE freight_records SET data=?,updated_by=?,updated_at=?,version=version+1 WHERE collection=? AND id=? AND version=?').bind(JSON.stringify(data),user.name,new Date().toISOString(),area,item.id,expectedVersion));}
   else{if(expectedVersion)problem('Este registro já existe no banco. Atualize a tela antes de salvar.',409);statements.push(db.prepare('INSERT OR IGNORE INTO freight_records(collection,id,data,owner_id,updated_by,updated_at,version) VALUES(?,?,?,?,?,?,1)').bind(area,item.id,JSON.stringify(data),owner,user.name,new Date().toISOString()));}
  }
  const versions:any={};if(statements.length)for(let i=0;i<statements.length;i+=80){const chunk=statements.slice(i,i+80),result:any[]=await db.batch(chunk);for(let j=0;j<result.length;j++)if(!result[j].meta.changes)problem('Este registro foi alterado por outra pessoa. Atualize a tela e reaplique sua alteração.',409);for(const item of input.rows.slice(i,i+80)){const row:any=await db.prepare('SELECT version FROM freight_records WHERE collection=? AND id=?').bind(area,item.id).first();if(row)versions[item.id]=row.version;}}
  return json({ok:true,count:statements.length,versions});
 }
 if(req.method==='DELETE'&&id){
  const old:any=await db.prepare('SELECT owner_id FROM freight_records WHERE collection=? AND id=?').bind(area,id).first();
  if(!old) return json({ok:true});
  if(!['Administrador','Admin','Logística','Equipe Logística'].includes(user.role)&&!(user.role==='Solicitante'&&old.owner_id===user.id))problem('Sem permissão para excluir este registro.',403);
  await db.prepare('DELETE FROM freight_records WHERE collection=? AND id=?').bind(area,id).run();return json({ok:true});
 }
 return json({error:'Operação não disponível.'},404);
}catch(e:any){return json({error:e.status?e.message:'Não foi possível sincronizar os fretes. Tente novamente.'},e.status||500);}}
export const GET=handle;export const POST=handle;export const PUT=handle;export const DELETE=handle;
