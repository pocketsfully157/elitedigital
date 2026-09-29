import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve,extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDB,settings,product,token,hashToken,passwordHash,passwordValid,transaction,expireOrders,releaseOrder,orderView } from './lib.mjs';

const db=openDB();
const port=Number(process.env.PORT||3000), host=process.env.HOST||'127.0.0.1';
const origin=process.env.ORIGIN||`http://127.0.0.1:${port}`;
const production=process.env.NODE_ENV==='production';
if(production&&!origin.startsWith('https://')) throw new Error('Em produção é obrigatório configurar ORIGIN com HTTPS.');
const publicDir=resolve('public');
const limits=new Map();
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const string=(value,min=1,max=200)=>{if(typeof value!=='string'||value.trim().length<min||value.length>max)fail('Verifique os campos preenchidos.');return value.trim();};
const email=value=>{const s=string(value,5,254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))fail('Introduza um email válido.');return s;};
const integer=(value,min,max)=>{if(!Number.isSafeInteger(value)||value<min||value>max)fail('Valor numérico inválido.');return value;};
const pass=value=>{if(typeof value!=='string'||value.length<12||value.length>128)fail('A palavra-passe deve ter entre 12 e 128 caracteres.');return value;};
function rate(req,key,max=15){const id=`${req.socket.remoteAddress}:${key}`,now=Date.now();let r=limits.get(id);if(!r||r.until<now){r={count:0,until:now+15*60000};limits.set(id,r);}if(++r.count>max)fail('Demasiadas tentativas. Tente novamente dentro de 15 minutos.',429);}
setInterval(()=>{for(const [k,r] of limits)if(r.until<Date.now())limits.delete(k);db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());db.prepare('DELETE FROM resets WHERE expires<?').run(Date.now());expireOrders(db);},60000).unref();
async function body(req){let size=0,parts=[];for await(const chunk of req){size+=chunk.length;if(size>65536)fail('Pedido demasiado grande.',413);parts.push(chunk);}try{return JSON.parse(Buffer.concat(parts).toString()||'{}');}catch{fail('Pedido inválido.');}}
function user(req){const sid=(req.headers.cookie||'').match(/(?:^|;\s*)elite_session=([a-f0-9]{64})(?:;|$)/)?.[1];if(!sid)return null;return db.prepare('SELECT u.id,u.name,u.email,u.role FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=? AND s.expires>?').get(hashToken(sid),Date.now())||null;}
function requireUser(req){const u=user(req);if(!u)fail('Inicie sessão para continuar.',401);return u;}
function admin(req){const u=requireUser(req);if(u.role!=='admin')fail('Acesso reservado à administração.',403);return u;}
function cookie(value,age=604800){return `elite_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${age}${production?'; Secure':''}`;}
function audit(u,action,id){db.prepare('INSERT INTO audit(actor,action,entity,created) VALUES(?,?,?,?)').run(u.id,action,id,new Date().toISOString());}
const safeUser=u=>({id:u.id,name:u.name,email:u.email,role:u.role});

const server=createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if(production)res.setHeader('Strict-Transport-Security','max-age=31536000');
  const send=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
  try{
    const url=new URL(req.url,origin),path=url.pathname;
    if(path.startsWith('/api/')){
      if(!['GET','HEAD'].includes(req.method)){
        if(req.headers.origin!==origin)fail('Origem do pedido não autorizada.',403);
        if(!req.headers['content-type']?.startsWith('application/json'))fail('Formato de pedido inválido.',415);
      }
      if(path==='/api/config'&&req.method==='GET')return send(settings(db));
      if(path==='/api/products'&&req.method==='GET')return send(db.prepare('SELECT * FROM products ORDER BY featured DESC,name').all().map(product));
      if(path==='/api/me'&&req.method==='GET')return send(user(req));
      if(path==='/api/register'&&req.method==='POST'){
        rate(req,'register',8);const b=await body(req),name=string(b.name,2,100),mail=email(b.email),password=pass(b.password);
        if(b.consent!==true)fail('Aceite a política de privacidade para criar a conta.');
        if(db.prepare('SELECT id FROM users WHERE email=?').get(mail))fail('Não foi possível criar a conta com este email.',409);
        const u={id:randomUUID(),name,email:mail,role:'customer'},hashed=await passwordHash(password);
        try{db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(u.id,name,mail,hashed,'customer',new Date().toISOString());}catch{fail('Não foi possível criar a conta com este email.',409);}
        const session=token();db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hashToken(session),u.id,Date.now()+604800000);res.setHeader('Set-Cookie',cookie(session));return send(u,201);
      }
      if(path==='/api/login'&&req.method==='POST'){
        rate(req,'login');const b=await body(req),mail=email(b.email);if(typeof b.password!=='string'||!b.password.length||b.password.length>128)fail('Credenciais inválidas.');const password=b.password;
        const u=db.prepare('SELECT * FROM users WHERE email=?').get(mail);
        const dummy='00000000000000000000000000000000:'+('00'.repeat(64));
        const valid=await passwordValid(password,u?.password||dummy);
        if(!u||!valid)fail('Email ou palavra-passe incorretos.',401);
        const session=token();db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hashToken(session),u.id,Date.now()+604800000);res.setHeader('Set-Cookie',cookie(session));return send(safeUser(u));
      }
      if(path==='/api/logout'&&req.method==='POST'){
        const sid=(req.headers.cookie||'').match(/elite_session=([a-f0-9]{64})/)?.[1];if(sid)db.prepare('DELETE FROM sessions WHERE token=?').run(hashToken(sid));res.setHeader('Set-Cookie',cookie('',0));return send({ok:true});
      }
      if(path==='/api/password/forgot'&&req.method==='POST'){
        rate(req,'forgot',5);const b=await body(req),mail=email(b.email);
        if(!process.env.RESEND_API_KEY||!process.env.EMAIL_FROM)fail('A recuperação por email ainda não está disponível. Contacte a loja.',503);
        const u=db.prepare('SELECT id FROM users WHERE email=?').get(mail);
        if(u){const t=token();db.prepare('INSERT INTO resets VALUES(?,?,?)').run(hashToken(t),u.id,Date.now()+1800000);
          const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.EMAIL_FROM,to:[mail],subject:'Recuperar acesso à loja',text:`Use esta ligação nos próximos 30 minutos para definir uma nova palavra-passe: ${origin}/#/recuperar/${t}\nSe não pediu esta alteração, ignore esta mensagem.`}),signal:AbortSignal.timeout(10000)});
          if(!response.ok){db.prepare('DELETE FROM resets WHERE token=?').run(hashToken(t));console.error('Falha no serviço de email:',response.status);}
        }return send({ok:true});
      }
      if(path==='/api/password/reset'&&req.method==='POST'){
        rate(req,'reset',8);const b=await body(req),t=string(b.token,64,64),password=pass(b.password),hashed=await passwordHash(password);
        transaction(db,()=>{const r=db.prepare('SELECT * FROM resets WHERE token=? AND expires>?').get(hashToken(t),Date.now());if(!r)fail('Ligação inválida ou expirada.');db.prepare('UPDATE users SET password=? WHERE id=?').run(hashed,r.user_id);db.prepare('DELETE FROM sessions WHERE user_id=?').run(r.user_id);db.prepare('DELETE FROM resets WHERE user_id=?').run(r.user_id);});return send({ok:true});
      }
      if(path==='/api/contact'&&req.method==='POST'){
        rate(req,'contact',5);const b=await body(req);if(b.consent!==true)fail('É necessário aceitar o tratamento deste pedido.');
        db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(randomUUID(),string(b.name,2,100),email(b.email),string(b.message,10,4000),new Date().toISOString());return send({ok:true},201);
      }
      if(path==='/api/orders'&&req.method==='GET'){
        const u=requireUser(req);expireOrders(db);return send(db.prepare('SELECT * FROM orders WHERE user_id=? ORDER BY created DESC').all(u.id).map(orderView));
      }
      if(path==='/api/orders'&&req.method==='POST'){
        const u=requireUser(req);rate(req,'orders',20);const b=await body(req),key=string(b.requestKey,16,100);
        const existing=db.prepare('SELECT * FROM orders WHERE user_id=? AND request_key=?').get(u.id,key);if(existing)return send(orderView(existing));
        const config=settings(db);if(!config.open)fail('A loja está em preparação. As encomendas abrem em breve.',503);
        if(b.terms!==true)fail('Aceite as condições de venda.');
        const address={name:string(b.name,2,100),street:string(b.street,5,200),city:string(b.city,2,100),postalCode:string(b.postalCode,8,8),country:'PT',nif:b.nif?string(b.nif,9,9):''};
        if(!/^\d{4}-\d{3}$/.test(address.postalCode))fail('Código postal inválido. Use 0000-000.');
        const district=Number(address.postalCode[0]);if(district===9)fail('Nesta fase, a entrega está disponível apenas em Portugal continental.');
        if(address.nif&&!/^\d{9}$/.test(address.nif))fail('NIF inválido.');
        const phone=string(b.phone,9,16);if(!/^\+?\d[\d ]{8,15}$/.test(phone))fail('Telefone inválido.');
        if(!Array.isArray(b.items)||!b.items.length||b.items.length>50)fail('O carrinho está vazio ou é demasiado grande.');
        expireOrders(db);
        const order=transaction(db,()=>{
          const quantities=new Map();for(const item of b.items){const id=string(item.id,1,100),q=integer(item.quantity,1,20);quantities.set(id,(quantities.get(id)||0)+q);}
          const items=[];let subtotal=0;
          for(const [id,q] of quantities){integer(q,1,20);const p=db.prepare('SELECT * FROM products WHERE id=?').get(id);if(!p||!p.verified||p.stock<q)fail('Um dos produtos já não tem a quantidade disponível. Atualize o carrinho.',409);items.push({id,name:p.name,price:p.price,quantity:q,image:p.image});subtotal+=p.price*q;db.prepare('UPDATE products SET stock=stock-? WHERE id=?').run(q,id);}
          const shipping=subtotal>=config.freeShipping?0:config.shipping,id='ED-'+randomUUID().slice(0,8).toUpperCase(),now=new Date().toISOString();
          db.prepare('INSERT INTO orders(id,user_id,request_key,status,total,shipping,address,items,phone,created,updated,expires) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,u.id,key,'awaiting_payment',subtotal+shipping,shipping,JSON.stringify(address),JSON.stringify(items),phone,now,now,Date.now()+86400000);
          return orderView(db.prepare('SELECT * FROM orders WHERE id=?').get(id));
        });return send(order,201);
      }
      const submitted=path.match(/^\/api\/orders\/([^/]+)\/payment$/);
      if(submitted&&req.method==='POST'){
        const u=requireUser(req);expireOrders(db);
        transaction(db,()=>{const o=db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(submitted[1],u.id);if(!o)fail('Encomenda não encontrada.',404);if(o.status==='payment_review')return;if(o.status!=='awaiting_payment')fail('Esta encomenda não aceita uma nova indicação de pagamento.',409);db.prepare("UPDATE orders SET status='payment_review',updated=? WHERE id=?").run(new Date().toISOString(),o.id);});return send({ok:true});
      }
      const cancel=path.match(/^\/api\/orders\/([^/]+)\/cancel$/);
      if(cancel&&req.method==='POST'){
        const u=requireUser(req);transaction(db,()=>{const o=db.prepare('SELECT * FROM orders WHERE id=? AND user_id=?').get(cancel[1],u.id);if(!o)fail('Encomenda não encontrada.',404);if(o.status!=='awaiting_payment')fail('Contacte a loja para cancelar uma encomenda com pagamento indicado.',409);releaseOrder(db,o,'cancelled');});return send({ok:true});
      }
      if(path==='/api/admin'&&req.method==='GET'){
        admin(req);expireOrders(db);return send({orders:db.prepare('SELECT o.*,u.email FROM orders o JOIN users u ON u.id=o.user_id ORDER BY o.created DESC').all().map(orderView),messages:db.prepare('SELECT * FROM messages ORDER BY created DESC').all(),audit:db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 100').all()});
      }
      if(path==='/api/admin/settings'&&req.method==='PUT'){
        const u=admin(req),b=await body(req),s={name:string(b.name,2,80),phone:string(b.phone,9,9),email:b.email?email(b.email):'',company:string(b.company||'',0,200),taxId:string(b.taxId||'',0,30),address:string(b.address||'',0,300),shipping:integer(b.shipping,0,50000),freeShipping:integer(b.freeShipping,0,10000000),terms:string(b.terms||'',0,12000),privacy:string(b.privacy||'',0,12000),returns:string(b.returns||'',0,12000),open:b.open===true,catalogReviewed:b.catalogReviewed===true};
        if(!/^9\d{8}$/.test(s.phone))fail('Indique um número móvel português válido.');
        if(s.open&&(!s.company||!s.taxId||!s.address||!s.email||s.terms.length<40||s.privacy.length<40||s.returns.length<40||!s.catalogReviewed))fail('Complete os dados comerciais, as políticas e a validação do catálogo antes de abrir a loja.');
        if(s.open&&!db.prepare('SELECT id FROM products WHERE verified=1 AND stock>0 LIMIT 1').get())fail('Valide pelo menos um produto com stock.');
        db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(s));audit(u,'settings.update','1');return send(s);
      }
      const edit=path.match(/^\/api\/admin\/products\/([^/]+)$/);
      if(edit&&req.method==='PUT'){
        const u=admin(req),b=await body(req);if(!db.prepare('SELECT id FROM products WHERE id=?').get(edit[1]))fail('Produto não encontrado.',404);
        db.prepare('UPDATE products SET name=?,price=?,stock=?,verified=?,description=? WHERE id=?').run(string(b.name,3,300),integer(b.price,1,100000000),integer(b.stock,0,100000),b.verified===true?1:0,string(b.description,3,4000),edit[1]);audit(u,'product.update',edit[1]);return send({ok:true});
      }
      const orderAdmin=path.match(/^\/api\/admin\/orders\/([^/]+)$/);
      if(orderAdmin&&req.method==='PUT'){
        const u=admin(req),b=await body(req);
        transaction(db,()=>{const o=db.prepare('SELECT * FROM orders WHERE id=?').get(orderAdmin[1]);if(!o)fail('Encomenda não encontrada.',404);
          const transitions={awaiting_payment:['paid','cancelled'],payment_review:['paid','cancelled'],paid:['shipped'],shipped:['completed']};
          if(!transitions[o.status]?.includes(b.status))fail('Alteração de estado não permitida.',409);
          if(b.status==='paid'&&b.paymentVerified!==true)fail('Confirme primeiro a transferência na sua aplicação MB WAY.');
          if(b.status==='cancelled'){if(o.status==='payment_review'&&b.noPaymentVerified!==true)fail('Confirme que não recebeu o pagamento antes de cancelar.');releaseOrder(db,o,'cancelled');}
          else db.prepare('UPDATE orders SET status=?,tracking=?,updated=? WHERE id=?').run(b.status,string(b.tracking===undefined?o.tracking:b.tracking,0,200),new Date().toISOString(),o.id);
          audit(u,'order.'+b.status,o.id);
        });return send({ok:true});
      }
      return send({error:'Página não encontrada.'},404);
    }
    if(!['GET','HEAD'].includes(req.method))fail('Método não permitido.',405);
    const target=resolve(publicDir,'.'+decodeURIComponent(path==='/'?'/index.html':path));
    if(!target.startsWith(publicDir+'/'))fail('Acesso negado.',403);
    let data;try{data=await readFile(target);}catch{fail('Página não encontrada.',404);}
    const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.jpg':'image/jpeg','.png':'image/png','.woff2':'font/woff2'};
    res.writeHead(200,{'Content-Type':types[extname(target)]||'application/octet-stream','Cache-Control':['.html','.js','.css'].includes(extname(target))?'no-cache':'public, max-age=3600'});res.end(req.method==='HEAD'?undefined:data);
  }catch(error){if(!error.status)console.error(error);if(!res.headersSent)send({error:error.status?error.message:'Ocorreu um erro. Tente novamente.'},error.status||500);else res.end();}
});
server.listen(port,host,()=>console.log(`Elite Digital disponível em ${origin}`));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>{db.close();process.exit(0);}));
