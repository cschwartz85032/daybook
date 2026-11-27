import { boardAccess } from './lib/sharing.mjs';
import { twilioProvider } from './lib/twilio/provider.mjs';
import { invitationSms, mobileAccount, smsCallbackPath } from './lib/invitation-sms.mjs';
import { contactAddress } from './lib/contact.mjs';
import { issueSetupCode, pendingInvitation, verifySetupCode } from './lib/enrollment.mjs';
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStore, InputError } from './lib/store.mjs';
import { token, digest, passwordHash, verifyPassword } from './lib/auth.mjs';

const root = dirname(fileURLToPath(import.meta.url));
export function createApp(options = {}) {
  const production = options.production ?? process.env.NODE_ENV === 'production';
  const port = options.port ?? Number(process.env.PORT || 8098);
  const publicUrl = new URL(options.publicUrl || process.env.PUBLIC_URL || `http://127.0.0.1:${port}`);
  if (production && publicUrl.protocol !== 'https:') throw new Error('PUBLIC_URL must be an HTTPS URL in production.');
  if (publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) throw new Error('PUBLIC_URL must contain only an origin and optional path.');
  const base = publicUrl.pathname.replace(/\/$/, '');
  const smsProvider = options.smsProvider === undefined ? twilioProvider() : options.smsProvider;
  const store = openStore(options.dbPath || process.env.DB_PATH || resolve(root, 'data/daybook.sqlite'), options.timeZone || process.env.APP_TIMEZONE || 'America/Phoenix');
  const texts = invitationSms(store,smsProvider,publicUrl);
  const assetRoot = existsSync(resolve(root, 'monday-assets')) ? resolve(root, 'monday-assets') : resolve(dirname(options.dbPath || process.env.DB_PATH || resolve(root,'data/daybook.sqlite')), 'monday-assets');
  const uploadRoot = resolve(dirname(options.dbPath || process.env.DB_PATH || resolve(root,'data/daybook.sqlite')), 'upload-assets');
  mkdirSync(uploadRoot,{recursive:true,mode:0o700});
  function purgeExpiredTrash() {
    const result=store.purgeExpiredTrash();
    for(const asset of result.assets){
      try{unlinkSync(resolve(asset.startsWith('local-')?uploadRoot:assetRoot,asset));}
      catch(error){if(error.code!=='ENOENT')console.error('Could not remove expired attachment:',asset,error.message);}
    }
    if(result.boards||result.items)console.log(`Expired trash removed: ${result.boards} boards, ${result.items} items, ${result.updates} updates.`);
    return result;
  }
  purgeExpiredTrash();
  const uploadTypes={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',pdf:'application/pdf',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',xls:'application/vnd.ms-excel',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',ppt:'application/vnd.ms-powerpoint',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation',txt:'text/plain',csv:'text/csv'};
  const cookieName = 'daybook_session';
  const cookie = (value, maxAge) => `${cookieName}=${value}; Path=${base || '/'}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${publicUrl.protocol === 'https:' ? '; Secure' : ''}`;
  const staticFiles = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/sharing.js',['sharing.js','text/javascript; charset=utf-8']], ['/workspace.js', ['workspace.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']], ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]].map(([url, [file, type]]) => [url, { body: readFileSync(resolve(root, 'public', file)), type }]));
  const maxBody = 8 * 1024 * 1024;
  async function receiveStatus(req,res,url,attempt) {
    if (!smsProvider) throw new InputError('Not found.',404);
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/x-www-form-urlencoded') throw new InputError('Expected form data.',415);
    let size=0;
    const chunks=[];
    for await (const chunk of req) {
      size+=chunk.length;
      if (size>16384) throw new InputError('Form too large.',413);
      chunks.push(chunk);
    }
    const fields=Object.create(null);
    for (const [key,value] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) {
      if (Object.hasOwn(fields,key)) throw new InputError('Duplicate field.');
      fields[key]=value;
    }
    if (!smsProvider.verifies(publicUrl.origin+url.pathname+url.search,req.headers['x-twilio-signature'],fields)) throw new InputError('Invalid status signature.',403);
    if (!texts.record(attempt,fields.MessageSid,fields.MessageStatus,fields.ErrorCode)) throw new InputError('Unknown text or status.',400);
    res.writeHead(204);
    res.end();
  }
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
  function checkAttachments(assets, access, userId, boardId) {
    if (assets === undefined) return;
    if (!Array.isArray(assets) || assets.length > 10) throw new InputError('Invalid attachments.');
    for (const a of assets) {
      if (!a || !/^local-[a-f0-9-]{36}$/.test(a.id) || !/^[a-z0-9]{1,8}$/.test(a.file_extension)) throw new InputError('Invalid attachment.');
      const file = a.id + '.' + a.file_extension;
      const uploaded = store.get('SELECT 1 FROM uploads WHERE filename=? AND user_id=? AND list_id=?',file,userId,boardId);
      if ((!uploaded && !access.asset(file,boardId)) || !existsSync(resolve(uploadRoot,file))) throw new InputError('Upload the attachments to this board first.');
    }
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
  function newSession(userId) {
    const raw = token(), csrf = token();
    store.run('DELETE FROM sessions WHERE expires<?', Date.now());
    store.run('INSERT INTO sessions VALUES(?,?,?,?)', digest(raw), userId, csrf, Date.now()+30*86400000);
    return {csrf,headers:{'Set-Cookie':cookie(raw,30*86400)}};
  }
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
      if (method==='POST' && path.startsWith(smsCallbackPath)) {
        const attempt=path.slice(smsCallbackPath.length);
        if (!/^[a-f0-9-]{36}$/i.test(attempt)) throw new InputError('Not found.',404);
        await receiveStatus(req,res,url,attempt);
        return;
      }
      if (method !== 'GET' && req.headers.origin !== publicUrl.origin) throw new InputError('Request origin rejected.', 403);
      const entry = path.match(/^\/api\/invitations\/([a-z0-9-]+)\/(entry|activate)$/i);
      if (entry && entry[2]==='entry' && method==='GET') {
        send(res,200,{needs_setup:Boolean(pendingInvitation(store,entry[1])?.needs_setup)}); return;
      }
      if (entry && entry[2]==='activate' && method==='POST') {
        if (session(req)) throw new InputError('Sign out before setting up another account.',409);
        const data = await body(req), id = entry[1];
        if (typeof data.password!=='string' || data.password.length<14 || data.password.length>1024) throw new InputError('Choose a password with 14–1024 characters.');
        const ip = process.env.TRUST_PROXY==='1' ? req.headers['x-real-ip'] || req.socket.remoteAddress : req.socket.remoteAddress;
        limit('setup:'+digest(String(ip)),30);
        verifySetupCode(store,id,data.contact,data.code);
        if (activeLogins>=3) throw new InputError('Please try again shortly.',429);
        const salt=token();
        let hash;
        activeLogins++;
        try { hash=await passwordHash(data.password,salt); } finally { activeLogins--; }
        const {invitation,login}=store.transaction(()=>{
          const invitation=verifySetupCode(store,id,data.contact,data.code);
          store.run('UPDATE users SET password_hash=?,salt=? WHERE id=?',hash,salt,invitation.user_id);
          store.run('DELETE FROM pending_accounts WHERE user_id=?',invitation.user_id);
          store.run('DELETE FROM setup_codes WHERE invitation_id IN (SELECT id FROM board_members WHERE user_id=?)',invitation.user_id);
          store.run("UPDATE board_members SET state='active' WHERE id=?",id);
          return {invitation,login:newSession(invitation.user_id)};
        });
        send(res,200,{username:invitation.username,csrf:login.csrf,list_id:invitation.list_id},login.headers); return;
      }
      if (path === '/api/login' && method === 'POST') {
        const data = await body(req);
        if (typeof data.username !== 'string' || data.username.length > 254 || typeof data.password !== 'string' || data.password.length > 1024) throw new InputError('Enter your sign-in name and password.');
        data.username = data.username.trim();
        const ip = process.env.TRUST_PROXY === '1' ? req.headers['x-real-ip'] || req.socket.remoteAddress : req.socket.remoteAddress;
        limit('ip:' + digest(String(ip)), 30);
        const identity = contactAddress(data.username)?.address || data.username.toLowerCase();
        limit('user:' + digest(identity), 10);
        if (activeLogins >= 3) throw new InputError('Please try again shortly.', 429);
        const user = store.get(`SELECT u.* FROM users u LEFT JOIN pending_accounts p ON p.user_id=u.id
          WHERE p.user_id IS NULL AND u.username IN (?,?) ORDER BY u.username=? DESC LIMIT 1`,data.username,identity,data.username);
        let valid;
        activeLogins++;
        try { valid = await verifyPassword(data.password, user); } finally { activeLogins--; }
        if (!valid) throw new InputError('The username or password is incorrect.', 401);
        store.run('DELETE FROM login_attempts WHERE reset_at<? OR key=?', Date.now(), 'user:' + digest(identity));
        const login=newSession(user.id);
        send(res, 200, { username: user.username, csrf:login.csrf },login.headers); return;
      }
      const auth = session(req);
      if (!auth) throw new InputError('Please sign in.', 401);
      if (method !== 'GET' && req.headers['x-csrf-token'] !== auth.csrf) throw new InputError('Your session changed. Refresh and try again.', 403);
      const access = boardAccess(store, auth.user_id);
      // Finish reading request data before checking the current board membership.
      const input = method === 'GET' || path === '/api/logout' ? {} : await body(req);
      const assetMatch=path.match(/^\/api\/assets\/([0-9]+|local-[a-f0-9-]{36})\.([a-z0-9]{1,8})$/);
      if(assetMatch&&method==='GET'){
        const local=assetMatch[1].startsWith('local-');
        const file=resolve(local?uploadRoot:assetRoot,`${assetMatch[1]}.${assetMatch[2]}`);
        if(!access.asset(`${assetMatch[1]}.${assetMatch[2]}`) || !existsSync(file))throw new InputError('Attachment not found.',404);
        const types={...uploadTypes};
        res.writeHead(200,{'Content-Type':types[assetMatch[2]]||'application/octet-stream','Content-Disposition':`${types[assetMatch[2]]?.startsWith('image/')?'inline':'attachment'}; filename="monday-attachment-${assetMatch[1]}.${assetMatch[2]}"`});
        res.end(readFileSync(file));return;
      }
      if(path==='/api/uploads'&&method==='POST'){
        if (input.list_id != null) access.board(input.list_id,'edit');
        else access.requireOwner();
        const name=String(input.name||'');
        const ext=name.split('.').pop().toLowerCase();
        if(name.length>200||!Object.hasOwn(uploadTypes,ext)||typeof input.bytes!=='string')throw new InputError('Choose a supported image or document.');
        if(typeof input.bytes!=='string'||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.bytes))throw new InputError('Invalid attachment.');
        const bytes=Buffer.from(input.bytes,'base64');
        if(!bytes.length||bytes.length>5*1024*1024)throw new InputError('Attachment must be 5 MB or smaller.');
        const id='local-'+randomUUID();
        writeFileSync(resolve(uploadRoot,`${id}.${ext}`),bytes,{flag:'wx',mode:0o600});
        store.run('INSERT INTO uploads(filename,user_id,list_id) VALUES(?,?,?)',`${id}.${ext}`,auth.user_id,input.list_id ?? null);
        send(res,201,{id,name,file_extension:ext});return;
      }
      if (path === '/api/session' && method === 'GET') { send(res, 200, { username: auth.username, csrf: auth.csrf }); return; }
      if (path === '/api/logout' && method === 'POST') { store.run('DELETE FROM sessions WHERE token_hash=?', auth.token_hash); send(res, 200, { ok: true }, { 'Set-Cookie': cookie('', 0) }); return; }
      if (path === '/api/data' && method === 'GET') {
        if (access.owner) store.runScheduledAutomations();
        send(res,200,{...access.snapshot(false),sms_enabled:Boolean(smsProvider)}); return;
      }
      if (path === '/api/preferences/last-board' && method === 'PATCH') {
        access.board(input.list_id,'open');
        store.run(`INSERT INTO last_open_boards(user_id,list_id) VALUES(?,?)
          ON CONFLICT(user_id) DO UPDATE SET list_id=excluded.list_id`,auth.user_id,input.list_id);
        send(res,200,{ok:true}); return;
      }
      if (path === '/api/export' && method === 'GET') {
        send(res,200,access.snapshot(true),{'Content-Disposition':`attachment; filename="daybook-${new Date().toISOString().slice(0,10)}.json"`}); return;
      }
      const codeRoute = path.match(/^\/api\/lists\/([a-z0-9-]+)\/members\/([a-z0-9-]+)\/setup-code$/i);
      if (method==='POST' && codeRoute) {
        access.board(codeRoute[1],'owner');
        const pending=pendingInvitation(store,codeRoute[2]);
        if (pending?.list_id===codeRoute[1] && smsProvider && mobileAccount(pending.username) && !texts.latest(pending.id)?.manual_setup) throw new InputError('Use Resend text for this invitation.',409);
        send(res,200,issueSetupCode(store,codeRoute[1],codeRoute[2])); return;
      }
      const textRoute=path.match(/^\/api\/lists\/([a-z0-9-]+)\/members\/([a-z0-9-]+)\/text$/i);
      if (method==='POST' && textRoute) {
        const [,boardId,id]=textRoute;
        const allowed=access.board(boardId,'share');
        const pending=pendingInvitation(store,id);
        if (pending?.list_id!==boardId || (!access.owner && (pending.invited_by!==auth.user_id || (pending.role==='edit' && allowed.role!=='edit')))) throw new InputError('Invitation unavailable.',404);
        send(res,200,await texts.send(boardId,id,auth.user_id)); return;
      }
      const members = path.match(/^\/api\/lists\/([a-z0-9-]+)\/members(?:\/([a-z0-9-]+))?$/i);
      if (members) {
        const [,id,member] = members;
        if (!member && method === 'GET') {
          const people=access.people(id,Boolean(smsProvider)).map(person=>{
            if (person.state==='pending' && mobileAccount(person.username)) {
              const sms=texts.latest(person.id);
              if (sms || smsProvider) return {...person,sms:sms || {state:'unsent'}};
            }
            return person;
          });
          send(res,200,people); return;
        }
        if (!member && method === 'POST') {
          const result=access.invite(id,input);
          const pending=pendingInvitation(store,result.id);
          if (smsProvider && mobileAccount(pending?.username)) {
            try { result.sms=await texts.send(id,result.id,auth.user_id); }
            catch (error) {
              if (error.status!==429) throw error;
              result.sms={state:'limited',reason:error.message};
            }
          } else if (result.needs_setup && access.owner) result.setup=issueSetupCode(store,id,result.id);
          send(res,201,result); return;
        }
        if (member && method === 'PATCH') { access.manage(id,member,input); send(res,200,{ok:true}); return; }
      }
      const accept = path.match(/^\/api\/invitations\/([a-z0-9-]+)\/accept$/i);
      if (accept && method === 'POST') { send(res,200,access.accept(accept[1])); return; }

      if (path === '/api/tasks' && method === 'POST') {
        access.board(input.list_id,'edit');
        if (!access.owner && input.source_id) throw new InputError('Source IDs are assigned during import.');
        send(res,201,store.insert(input)); return;
      }
      const taskRoute = path.match(/^\/api\/tasks\/([a-z0-9-]+)(?:\/(.*))?$/i);
      if (taskRoute) {
        const [,id,action] = taskRoute;
        const task = store.findTask(id);
        access.board(task?.list_id,'edit');
        if (method === 'PATCH' && !action) {
          if ('list_id' in input) access.board(input.list_id,'edit');
          send(res,200,store.update(id,input)); return;
        }
        if (method === 'POST') {
          if (input.parent_id) access.board(store.findTask(input.parent_id)?.list_id,'edit');
          if (input.target_id) access.board(store.findTask(input.target_id)?.list_id,'edit');
          const child = action?.match(/^subitems\/([a-z0-9-]+)\/(updates|convert-to-item|move)$/i);
          if (action === 'updates' || child?.[2] === 'updates') {
            checkAttachments(input.assets,access,auth.user_id,task.list_id);
            const result = child ? store.addSubitemUpdate(id,child[1],input,auth.username) : store.addUpdate(id,input,auth.username);
            send(res,201,result); return;
          }
          if (action === 'subitems') { send(res,201,store.addSubitem(id,input)); return; }
          if (action === 'below') { send(res,201,store.createBelow(id)); return; }
          if (action === 'reorder') { send(res,200,store.reorderTask(id,input)); return; }
          if (action === 'convert-to-subitem') { send(res,200,store.convertToSubitem(id,input.parent_id)); return; }
          if (child?.[2] === 'convert-to-item') { send(res,200,store.convertSubitemToItem(id,child[1])); return; }
          if (child?.[2] === 'move') { send(res,200,store.moveSubitem(id,child[1],input.parent_id)); return; }
        }
      }
      if (path === '/api/lists' && method === 'POST') { access.requireOwner(); send(res,201,store.addList(input)); return; }
      const listMatch = path.match(/^\/api\/lists\/([a-z0-9-]+)$/i);
      if (listMatch && method === 'PATCH') {
        access.board(listMatch[1],'deleted' in input ? 'owner' : 'edit');
        send(res,200,store.updateList(listMatch[1],input)); return;
      }
      if (method === 'POST' && path === '/api/groups') { access.board(input.list_id,'edit'); send(res,201,store.addGroup(input)); return; }
      if (method === 'POST' && path === '/api/automations') { access.board(input.list_id,'edit'); send(res,201,store.addAutomation(input)); return; }
      const group = path.match(/^\/api\/groups\/([a-z0-9-]+)$/i);
      if (group && method === 'PATCH') {
        access.board(store.get('SELECT list_id FROM board_groups WHERE id=?',group[1])?.list_id,'edit');
        send(res,200,store.updateGroup(group[1],input)); return;
      }
      const rule = path.match(/^\/api\/automations\/([a-z0-9-]+)$/i);
      if (rule && method === 'PATCH') {
        access.board(store.get('SELECT list_id FROM automation_rules WHERE id=?',rule[1])?.list_id,'edit');
        send(res,200,store.updateAutomation(rule[1],input)); return;
      }
      if (path === '/api/import' && method === 'POST') {
        access.requireOwner(); const result=store.importData(input); purgeExpiredTrash(); send(res,200,result); return;
      }
      throw new InputError('Not found.', 404);
    } catch (e) {
      if (!(e instanceof InputError)) console.error('Request failed:', e.code || e.name);
      if (!res.headersSent) send(res, e.status || 500, { error: e instanceof InputError ? e.message : 'Something went wrong. Your changes were not saved.' });
      else res.end();
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000; server.keepAliveTimeout = 5000;
  return { server, store, publicUrl, port, purgeExpiredTrash };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const app = createApp();
  app.server.listen(app.port, process.env.HOST || '127.0.0.1', () => console.log(`Daybook listening at ${app.publicUrl.href}`));
  const automationTimer=setInterval(()=>{try{app.store.runScheduledAutomations();app.purgeExpiredTrash();}catch(error){console.error('Scheduled maintenance failed:',error.message);}},60*60*1000);
  automationTimer.unref();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.server.close(() => { app.store.db.close(); process.exit(0); }));
}
