import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../app/chatgpt-auth';
import {OWNER_EMAIL,problem} from './invoice-policy.js';
export async function actor(){
 const u=await getChatGPTUser();if(!u)problem('Entre com sua conta ChatGPT para acessar as faturas.',401);
 const email=u!.email.toLowerCase();
 if(email===OWNER_EMAIL)return {id:u!.userId,email,name:u!.displayName,role:'Administrador'};
 const member:any=await env.DB!.prepare('SELECT * FROM invoice_members WHERE email=? AND active=1').bind(email).first();
 if(!member||member.user_id&&member.user_id!==u!.userId)problem('Sua conta ainda não está autorizada. Peça ao Giovanni para cadastrar seu e-mail na área Acessos.',403);
 if(!member.user_id){await env.DB!.prepare('UPDATE invoice_members SET user_id=? WHERE email=? AND user_id IS NULL').bind(u!.userId,email).run();const bound:any=await env.DB!.prepare('SELECT user_id FROM invoice_members WHERE email=?').bind(email).first();if(bound?.user_id!==u!.userId)problem('Identidade não autorizada.',403);}
 return {id:u!.userId,email,name:member.name,role:member.role};
}
