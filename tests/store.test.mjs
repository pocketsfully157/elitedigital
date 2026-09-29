import test,{after,before} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {openDB,passwordHash,settings} from '../lib.mjs';

let folder,db,server,customerCookie,adminCookie;
const origin='http://127.0.0.1:3198';
const password='Test-only-secret-9824';
async function req(path,{method='GET',data,cookie='',csrf=origin}={}){
  const r=await fetch(origin+'/api'+path,{method,headers:{'Content-Type':'application/json',Origin:csrf,Cookie:cookie},body:data===undefined?undefined:JSON.stringify(data)});
  return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
}
const orderBody=()=>({name:'Cliente de Teste',street:'Rua de Teste, 1',city:'Lisboa',postalCode:'1000-001',phone:'910000000',terms:true,requestKey:randomUUID(),items:[{id:'347629',quantity:1,price:1}]});
const post=(path,data,cookie=customerCookie)=>req(path,{method:'POST',data,cookie});
before(async()=>{
  folder=await mkdtemp(join(tmpdir(),'elite-test-'));const path=join(folder,'store.sqlite');db=openDB(path);
  db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run('admin-test','Administrador','admin@example.test',await passwordHash(password),'admin',new Date().toISOString());
  server=spawn(process.execPath,['server.mjs'],{env:{...process.env,PORT:'3198',DB_PATH:path,ORIGIN:origin,NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
  let logs='';server.stderr.on('data',b=>logs+=b);
  await Promise.race([once(server.stdout,'data'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Server timeout '+logs)),10000).unref())]);
});
after(async()=>{if(server){const ended=once(server,'exit');server.kill();await ended;}db?.close();if(folder)await rm(folder,{recursive:true,force:true});});

test('catálogo persistente, validação, autenticação e processo real de encomenda',async t=>{
  await t.test('catálogo tem imagens e não anuncia stock não verificado',async()=>{const r=await req('/products');assert.equal(r.status,200);assert.ok(r.data.length>100);assert.ok(r.data.every(p=>p.stock===0&&p.verified===0));assert.ok(r.data.every(p=>p.image.startsWith('/assets/')));});
  await t.test('bloqueia pedidos provenientes de outro site',async()=>{const r=await req('/register',{method:'POST',csrf:'https://attacker.invalid',data:{}});assert.equal(r.status,403);});
  await t.test('registo exige consentimento e palavra-passe robusta',async()=>{const r=await post('/register',{name:'Cliente Teste',email:'customer@example.test',password:'123',consent:true},'');assert.equal(r.status,400);});
  await t.test('registo cria sessão HttpOnly e credenciais protegidas',async()=>{const r=await post('/register',{name:'Cliente Teste',email:'customer@example.test',password,consent:true},'');assert.equal(r.status,201);customerCookie=r.cookie;assert.ok(customerCookie);assert.equal(r.data.role,'customer');assert.equal(r.data.password,undefined);const u=db.prepare('SELECT password FROM users WHERE email=?').get('customer@example.test');assert.notEqual(u.password,password);});
  await t.test('cliente não pode aceder ao painel de administração',async()=>{assert.equal((await req('/admin',{cookie:customerCookie})).status,403);});
  await t.test('login rejeita credenciais incorretas',async()=>{assert.equal((await post('/login',{email:'customer@example.test',password:'wrong-password-123'},'')).status,401);});
  await t.test('login administrativo e configuração inicial',async()=>{const r=await post('/login',{email:'admin@example.test',password},'');assert.equal(r.status,200);adminCookie=r.cookie;assert.equal((await req('/config')).data.open,false);});
  await t.test('a loja fechada não aceita encomendas',async()=>{assert.equal((await post('/orders',orderBody())).status,503);assert.equal(db.prepare('SELECT count(*) AS n FROM orders').get().n,0);});
  await t.test('abertura exige dados comerciais e stock validado',async()=>{const r=await req('/admin/settings',{method:'PUT',cookie:adminCookie,data:{...settings(db),open:true}});assert.equal(r.status,400);});
  await t.test('administrador valida produto e abre a loja',async()=>{const p=db.prepare('SELECT * FROM products WHERE id=?').get('347629');assert.equal((await req('/admin/products/347629',{method:'PUT',cookie:adminCookie,data:{...p,price:100000,stock:5,verified:true}})).status,200);const data={...settings(db),open:true,company:'Empresa de teste',taxId:'123456789',address:'Rua de Teste, Lisboa',email:'store@example.test',catalogReviewed:true,terms:'Condições comerciais de teste para verificação automatizada do sistema.',privacy:'Política de privacidade de teste para verificação automatizada do sistema.',returns:'Política de entregas e devoluções de teste para verificação automatizada do sistema.'};assert.equal((await req('/admin/settings',{method:'PUT',cookie:adminCookie,data})).status,200);});
  let first;
  await t.test('preços são calculados no servidor e pedidos repetidos não duplicam stock',async()=>{const data=orderBody();first=await post('/orders',data);assert.equal(first.status,201);assert.equal(first.data.total,100000);assert.equal(first.data.items[0].price,100000);assert.equal(first.data.status,'awaiting_payment');const duplicate=await post('/orders',data);assert.equal(duplicate.data.id,first.data.id);assert.equal(db.prepare('SELECT stock FROM products WHERE id=?').get('347629').stock,4);});
  await t.test('uma encomenda inválida não desconta parte do stock',async()=>{const data=orderBody();data.items.push({id:'not-present',quantity:1});assert.equal((await post('/orders',data)).status,409);assert.equal(db.prepare('SELECT stock FROM products WHERE id=?').get('347629').stock,4);});
  await t.test('recusa quantidade superior ao stock e códigos postais inválidos',async()=>{const data=orderBody();data.items[0].quantity=20;assert.equal((await post('/orders',data)).status,409);data.items[0].quantity=1;data.postalCode='9000-001';assert.equal((await post('/orders',data)).status,400);});
  await t.test('cliente indica pagamento sem conseguir confirmar entrada de dinheiro',async()=>{assert.equal((await post(`/orders/${first.data.id}/payment`)).status,200);const row=db.prepare('SELECT status FROM orders WHERE id=?').get(first.data.id);assert.equal(row.status,'payment_review');assert.equal((await req('/admin/orders/'+first.data.id,{method:'PUT',cookie:customerCookie,data:{status:'paid',paymentVerified:true}})).status,403);});
  await t.test('administrador precisa de confirmar verificação do pagamento',async()=>{const path='/admin/orders/'+first.data.id;assert.equal((await req(path,{method:'PUT',cookie:adminCookie,data:{status:'paid'}})).status,400);assert.equal((await req(path,{method:'PUT',cookie:adminCookie,data:{status:'paid',paymentVerified:true}})).status,200);assert.equal((await req(path,{method:'PUT',cookie:adminCookie,data:{status:'paid',paymentVerified:true}})).status,409);});
  await t.test('fluxo de envio e entrega preserva histórico',async()=>{const path='/admin/orders/'+first.data.id;assert.equal((await req(path,{method:'PUT',cookie:adminCookie,data:{status:'shipped',tracking:'TEST-123'}})).status,200);assert.equal((await req(path,{method:'PUT',cookie:adminCookie,data:{status:'completed'}})).status,200);const list=(await req('/orders',{cookie:customerCookie})).data;assert.equal(list[0].status,'completed');});
  await t.test('cancelar liberta stock apenas uma vez',async()=>{const order=await post('/orders',orderBody());assert.equal(order.status,201);assert.equal((await post(`/orders/${order.data.id}/cancel`)).status,200);assert.equal((await post(`/orders/${order.data.id}/cancel`)).status,409);assert.equal(db.prepare('SELECT stock FROM products WHERE id=?').get('347629').stock,4);});
  await t.test('reservas não pagas expiram e libertam stock',async()=>{const order=await post('/orders',orderBody());db.prepare('UPDATE orders SET expires=? WHERE id=?').run(Date.now()-1000,order.data.id);const list=(await req('/orders',{cookie:customerCookie})).data;assert.equal(list.find(o=>o.id===order.data.id).status,'expired');assert.equal(db.prepare('SELECT stock FROM products WHERE id=?').get('347629').stock,4);});
  await t.test('clientes não veem as encomendas de outro cliente',async()=>{const other=await post('/register',{name:'Outro Cliente',email:'other@example.test',password,consent:true},'');assert.equal((await req('/orders',{cookie:other.cookie})).data.length,0);assert.equal((await post(`/orders/${first.data.id}/payment`,{},other.cookie)).status,404);});
  await t.test('contactos são persistidos e apresentados à administração',async()=>{assert.equal((await post('/contact',{name:'Cliente',email:'customer@example.test',message:'Preciso de ajuda com a minha encomenda.',consent:true})).status,201);const panel=await req('/admin',{cookie:adminCookie});assert.equal(panel.data.messages.length,1);assert.ok(panel.data.audit.length>=4);});
  await t.test('sair revoga a sessão',async()=>{assert.equal((await post('/logout')).status,200);assert.equal((await req('/me',{cookie:customerCookie})).data,null);assert.equal((await req('/orders',{cookie:customerCookie})).status,401);});
});
