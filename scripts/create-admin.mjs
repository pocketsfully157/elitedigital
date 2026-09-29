import { openDB,passwordHash } from '../lib.mjs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
const prompt=createInterface({input:process.stdin,output:process.stdout});
const email=(process.env.ADMIN_EMAIL || await prompt.question('Email do administrador: ')).trim().toLowerCase();
// A palavra-passe inicial é definida através do ambiente, nunca incluída no código.
const password=process.env.ADMIN_PASSWORD;
prompt.close();
if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!password||password.length<12||password.length>128){console.error('Define ADMIN_EMAIL e ADMIN_PASSWORD (12 a 128 caracteres) no ambiente e executa npm run admin.');process.exit(1);}
const db=openDB();
if(db.prepare('SELECT id FROM users WHERE email=?').get(email)){console.error('Já existe uma conta com este email. Nenhuma alteração realizada.');process.exit(1);}
db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(randomUUID(),'Administrador',email,await passwordHash(password),'admin',new Date().toISOString());
db.close();console.log('Administrador criado. Inicia sessão em /#/conta e abre /#/admin.');
