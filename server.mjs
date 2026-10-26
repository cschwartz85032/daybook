import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStore, InputError } from './lib/store.mjs';
import { token, digest, verifyPassword } from './lib/auth.mjs';

const root = dirname(fileURLToPath(import.meta.url));
export function createApp(options = {}) {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const port = options.port ?? Number(process.env.PORT || 8098);
  const publicUrl = new URL(options.publicUrl || process.env.PUBLIC_URL || `http://127.0.0.1:${port}`);
  if (production && publicUrl.protocol !== 'https:') throw new Error('PUBLIC_URL must be an HTTPS URL in production.');
  if (publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) throw new Error('PUBLIC_URL must contain only an origin and optional path.');
  const base = publicUrl.pathname.replace(/\/$/, '');
  const store = openStore(options.dbPath || process.env.DB_PATH || resolve(root, 'data/daybook.sqlite'), options.timeZone || process.env.APP_TIMEZONE || 'America/Phoenix');
  const assetRoot = existsSync(resolve(root, 'monday-assets')) ? resolve(root, 'monday-assets') : resolve(dirname(options.dbPath || process.env.DB_PATH || resolve(root,'data/daybook.sqlite')), 'monday-assets');
  const uploadRoot = resolve(dirname(options.dbPath || process.env.DB_PATH || resolve(root,'data/daybook.sqlite')), 'upload-assets');
  mkdirSync(uploadRoot,{recursive:true,mode:0o700});
  const uploadTypes={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',pdf:'application/pdf',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',ppt:'application/vnd.ms-powerpoint',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',txt:'text/plain',csv:'text/csv'};
  const cookieName = 'daybook_session';
  const cookie = (value, maxAge) => `${cookieName}=${value}; Path=${base || '/'}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${publicUrl.protocol === 'https:' ? '; Secure' : ''}`;
  const staticFiles = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/workspace.js', ['workspace.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']], ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]].map(([url, [file, type]]) => [url, { body: readFileSync(resolve(root, 'public', file)), type }]));
  const maxBody = 8 * 1024 * 1024;
  async function body(req) {
    if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new InputError('Send JSON.', 415);
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxBody) throw new InputError('This file is too large (8 MB maximum).', 413);
      chunks.push(chunk);
    }
    try {
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
      return data;
    } catch { throw new InputError('Invalid JSON.'); }
  }
  function session(req) {
    const raw = (req.headers.cookie || '').split(';').map(c => c.trim()).find(c => c.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    if (!raw || raw.length > 100) return null;
    return store.get('SELECT s.*, u.username FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=? AND expires>?', digest(raw), Date.now());
  }
  const send = (res, status, data, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(data));
  };
  function limit(key, maximum) {
    const now = Date.now();
    const row = store.get('SELECT * FROM login_attempts WHERE key=?', key);
    if (row && row.reset_at > now && row.count >= maximum) throw new InputError('Too many sign-in attempts. Try again in 15 minutes.', 429);
    store.run('INSERT INTO login_attempts(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=?,reset_at=?', key, now + 900000, row && row.reset_at > now ? row.count + 1 : 1, row && row.reset_at > now ? row.reset_at : now + 900000);
  }
  let activeLogins = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
    if (publicUrl.protocol === 'https:') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      const url = new URL(req.url, publicUrl);
      if (req.method === 'GET' && base && url.pathname === base) {
        res.writeHead(308, { Location: base + '/' }); res.end(); return;
      }
      if (base && !url.pathname.startsWith(base + '/')) throw new InputError('Not found.', 404);
      const path = url.pathname.slice(base.length) || '/';
      const method = req.method;
      if (method === 'GET' && path === '/healthz') { store.get('SELECT 1'); send(res, 200, { status: 'ok' }); return; }
      if (['GET', 'HEAD'].includes(method) && staticFiles.has(path)) {
        const f = staticFiles.get(path); res.writeHead(200, { 'Content-Type': f.type }); res.end(method === 'HEAD' ? undefined : f.body); return;
      }
      if (!path.startsWith('/api/')) throw new InputError('Not found.', 404);
      if (!['GET', 'POST', 'PATCH'].includes(method)) throw new InputError('Method not allowed.', 405);
      if (method !== 'GET' && req.headers.origin !== publicUrl.origin) throw new InputError('Request origin rejected.', 403);
      if (path === '/api/login' && method === 'POST') {
        const data = await body(req);
        if (typeof data.username !== 'string' || data.username.length > 80 || typeof data.password !== 'string' || data.password.length > 1024) throw new InputError('Enter your username and password.');
        data.username = data.username.trim();
        const ip = process.env.TRUST_PROXY === '1' ? req.headers['x-real-ip'] || req.socket.remoteAddress : req.socket.remoteAddress;
        limit('ip:' + digest(String(ip)), 30);
        limit('user:' + digest(data.username.toLowerCase()), 10);
        if (activeLogins >= 3) throw new InputError('Please try again shortly.', 429);
        const user = store.get('SELECT * FROM users WHERE username=?', data.username.trim());
        let valid;
        activeLogins++;
        try { valid = await verifyPassword(data.password, user); } finally { activeLogins--; }
        if (!valid) throw new InputError('The username or password is incorrect.', 401);
        const raw = token(), csrf = token();
        store.run('DELETE FROM sessions WHERE expires<?', Date.now());
        store.run('DELETE FROM login_attempts WHERE reset_at<? OR key=?', Date.now(), 'user:' + digest(data.username.toLowerCase()));
        store.run('INSERT INTO sessions VALUES(?,?,?,?)', digest(raw), user.id, csrf, Date.now() + 30 * 86400000);
        send(res, 200, { username: user.username, csrf }, { 'Set-Cookie': cookie(raw, 30 * 86400) }); return;
      }
      const auth = session(req);
      if (!auth) throw new InputError('Please sign in.', 401);
      if (method !== 'GET' && req.headers['x-csrf-token'] !== auth.csrf) throw new InputError('Your session changed. Refresh and try again.', 403);
      const assetMatch=path.match(/^\/api\/assets\/([0-9]+|local-[a-f0-9-]{36})\.([a-z0-9]{1,8})$/);
      if(assetMatch&&method==='GET'){
        const local=assetMatch[1].startsWith('local-');
        const file=resolve(local?uploadRoot:assetRoot,`${assetMatch[1]}.${assetMatch[2]}`);
        if(!existsSync(file))throw new InputError('Attachment not found.',404);
        const types={...uploadTypes};
        res.writeHead(200,{'Content-Type':types[assetMatch[2]]||'application/octet-stream','Content-Disposition':`${types[assetMatch[2]]?.startsWith('image/')?'inline':'attachment'}; filename="monday-attachment-${assetMatch[1]}.${assetMatch[2]}"`});
        res.end(readFileSync(file));return;
      }
      if(path==='/api/uploads'&&method==='POST'){
        const input=await body(req),name=String(input.name||'');
        const ext=name.split('.').pop().toLowerCase();
        if(name.length>200||!Object.hasOwn(uploadTypes,ext)||typeof input.bytes!=='string')throw new InputError('Choose a supported image or document.');
        if(typeof input.bytes!=='string'||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.bytes))throw new InputError('Invalid attachment.');
        const bytes=Buffer.from(input.bytes,'base64');
        if(!bytes.length||bytes.length>5*1024*1024)throw new InputError('Attachment must be 5 MB or smaller.');
        const id='local-'+randomUUID();
        writeFileSync(resolve(uploadRoot,`${id}.${ext}`),bytes,{flag:'wx',mode:0o600});
        send(res,201,{id,name,file_extension:ext});return;
      }
      if (path === '/api/session' && method === 'GET') { send(res, 200, { username: auth.username, csrf: auth.csrf }); return; }
      if (path === '/api/logout' && method === 'POST') { store.run('DELETE FROM sessions WHERE token_hash=?', auth.token_hash); send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) }); return; }
      if (path === '/api/data' && method === 'GET') { store.runScheduledAutomations(); send(res, 200, store.snapshot()); return; }
      if (path === '/api/export' && method === 'GET') { send(res, 200, store.snapshot(), { 'Content-Disposition': `attachment; filename="daybook-${new Date().toISOString().slice(0, 10)}.json"` }); return; }
      if (path === '/api/tasks' && method === 'POST') { send(res, 201, store.insert(await body(req))); return; }
      const taskUpdates=path.match(/^\/api\/tasks\/([a-z0-9-]+)\/updates$/i);
      if(taskUpdates&&method==='POST'){const input=await body(req);if(input.assets?.some(a=>!a||!/^local-[a-f0-9-]{36}$/.test(a.id)||!/^[a-z0-9]{1,8}$/.test(a.file_extension)||!existsSync(resolve(uploadRoot,`${a.id}.${a.file_extension}`))))throw new InputError('Upload the attachments first.');send(res,201,store.addUpdate(taskUpdates[1],input,auth.username));return;}
      const subitemUpdates=path.match(/^\/api\/tasks\/([a-z0-9-]+)\/subitems\/([a-z0-9-]+)\/updates$/i);
      if(subitemUpdates&&method==='POST'){const input=await body(req);if(input.assets?.some(a=>!a||!/^local-[a-f0-9-]{36}$/.test(a.id)||!/^[a-z0-9]{1,8}$/.test(a.file_extension)||!existsSync(resolve(uploadRoot,`${a.id}.${a.file_extension}`))))throw new InputError('Upload the attachments first.');send(res,201,store.addSubitemUpdate(subitemUpdates[1],subitemUpdates[2],input,auth.username));return;}
      const below = path.match(/^\/api\/tasks\/([a-z0-9-]+)\/below$/i);
      if (below && method === 'POST') { send(res, 201, store.createBelow(below[1])); return; }
      const convert = path.match(/^\/api\/tasks\/([a-z0-9-]+)\/convert-to-subitem$/i);
      if (convert && method === 'POST') { const input=await body(req); send(res, 200, store.convertToSubitem(convert[1],input.parent_id)); return; }
      const subitem = path.match(/^\/api\/tasks\/([a-z0-9-]+)\/subitems\/([a-z0-9-]+)\/(convert-to-item|move)$/i);
      if (subitem && method === 'POST') { const input=await body(req); send(res, 200, subitem[3]==='convert-to-item'?store.convertSubitemToItem(subitem[1],subitem[2]):store.moveSubitem(subitem[1],subitem[2],input.parent_id)); return; }
      const match = path.match(/^\/api\/tasks\/([a-z0-9-]+)$/i);
      if (match && method === 'PATCH') { send(res, 200, store.update(match[1], await body(req))); return; }
      if (path === '/api/lists' && method === 'POST') { send(res, 201, store.addList(await body(req))); return; }
      const listMatch = path.match(/^\/api\/lists\/([a-z0-9-]+)$/i);
      if (listMatch && method === 'PATCH') { send(res, 200, store.updateList(listMatch[1],await body(req))); return; }
      if (path === '/api/groups' && method === 'POST') { send(res, 201, store.addGroup(await body(req))); return; }
      const groupMatch = path.match(/^\/api\/groups\/([a-z0-9-]+)$/i);
      if (groupMatch && method === 'PATCH') { send(res, 200, store.updateGroup(groupMatch[1],await body(req))); return; }
      if (path === '/api/automations' && method === 'POST') { send(res, 201, store.addAutomation(await body(req))); return; }
      const automationMatch=path.match(/^\/api\/automations\/([a-z0-9-]+)$/i);
      if(automationMatch&&method==='PATCH'){send(res,200,store.updateAutomation(automationMatch[1],await body(req)));return;}
      if (path === '/api/import' && method === 'POST') { send(res, 200, store.importData(await body(req))); return; }
      throw new InputError('Not found.', 404);
    } catch (e) {
      if (!(e instanceof InputError)) console.error('Request failed:', e.code || e.name);
      if (!res.headersSent) send(res, e.status || 500, { error: e instanceof InputError ? e.message : 'Something went wrong. Your changes were not saved.' });
      else res.end();
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000; server.keepAliveTimeout = 5000;
  return { server, store, publicUrl, port };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createApp();
  app.server.listen(app.port, process.env.HOST || '127.0.0.1', () => console.log(`Daybook listening at ${app.publicUrl.href}`));
  const automationTimer=setInterval(()=>{try{app.store.runScheduledAutomations();}catch(error){console.error('Scheduled automation failed:',error.message);}},60*60*1000);
  automationTimer.unref();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.server.close(() => { app.store.db.close(); process.exit(0); }));
}
