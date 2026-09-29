import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
const scrypt = promisify(scryptCallback);
export const hashToken = value => createHash('sha256').update(value).digest('hex');
export const token = () => randomBytes(32).toString('hex');
export async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password,salt,64)).toString('hex')}`;
}
export async function passwordValid(password, stored) {
  const [salt,hash] = stored.split(':');
  const actual = await scrypt(password,salt,64);
  return timingSafeEqual(actual,Buffer.from(hash,'hex'));
}
export function openDB(path = process.env.DB_PATH || './data/store.sqlite') {
  mkdirSync(dirname(resolve(path)),{recursive:true});
  const db=new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, subcategory TEXT NOT NULL, brand TEXT NOT NULL, price INTEGER NOT NULL CHECK(price>0), stock INTEGER NOT NULL DEFAULT 0 CHECK(stock>=0), verified INTEGER NOT NULL DEFAULT 0, image TEXT NOT NULL, description TEXT NOT NULL, specs TEXT NOT NULL, featured INTEGER DEFAULT 0, source TEXT);
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'customer', created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS resets(token TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id) ON DELETE CASCADE,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id), request_key TEXT NOT NULL, status TEXT NOT NULL, total INTEGER NOT NULL, shipping INTEGER NOT NULL, address TEXT NOT NULL, items TEXT NOT NULL, phone TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, expires INTEGER NOT NULL, tracking TEXT DEFAULT '', UNIQUE(user_id,request_key));
    CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL,message TEXT NOT NULL,created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,entity TEXT NOT NULL,created TEXT NOT NULL);
  `);
  if(!db.prepare('SELECT id FROM settings WHERE id=1').get()) {
    db.prepare('INSERT INTO settings VALUES(1,?)').run(JSON.stringify({name:'Elite Digital',phone:'928388859',open:false,company:'',taxId:'',address:'',email:'',shipping:499,freeShipping:15000,terms:'',privacy:'',returns:'',catalogReviewed:false}));
    const insert=db.prepare('INSERT INTO products VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for(const p of JSON.parse(readFileSync(new URL('./data/catalog.json',import.meta.url),'utf8'))) insert.run(p.id,p.name,p.category,p.subcategory,p.brand,p.price,0,0,p.image,p.description,JSON.stringify(p.specs),p.featured,p.source);
  }
  return db;
}
export function transaction(db,fn){ db.exec('BEGIN IMMEDIATE'); try{const v=fn();db.exec('COMMIT');return v;}catch(e){db.exec('ROLLBACK');throw e;} }
export function settings(db){return JSON.parse(db.prepare('SELECT value FROM settings WHERE id=1').get().value);}
export function product(p){return {...p,specs:JSON.parse(p.specs)};}
export function releaseOrder(db,order,status){
  for(const item of JSON.parse(order.items)) db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(item.quantity,item.id);
  db.prepare('UPDATE orders SET status=?,updated=? WHERE id=?').run(status,new Date().toISOString(),order.id);
}
export function expireOrders(db){ transaction(db,()=>{for(const o of db.prepare("SELECT * FROM orders WHERE status='awaiting_payment' AND expires<?").all(Date.now())) releaseOrder(db,o,'expired');}); }
export function orderView(o){return {...o,address:JSON.parse(o.address),items:JSON.parse(o.items)};}
