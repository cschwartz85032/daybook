import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { setAccount } from '../scripts/account.mjs';
import { openStore } from '../lib/store.mjs';

test('private API, sign in, CSRF, CRUD, export, sign out, and restart sessions', async () => {
  const dir = mkdtempSync(join(tmpdir(),'daybook-http-')), dbPath = join(dir,'test.sqlite');
  const password = 'Only for automated tests 6042!';
  await setAccount(dbPath,'test',password);
  const app = createApp({dbPath,publicUrl:'http://127.0.0.1:8098/tasks',port:0});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/tasks`;
  const headers = {'Content-Type':'application/json', Origin:'http://127.0.0.1:8098'};
  const call = (path,method='GET',body,h=headers) => fetch(base+path,{method,headers:h,body:body?JSON.stringify(body):undefined});
  try {
    assert.equal((await call('/healthz')).status,200);
    assert.equal((await call('/api/data')).status,401);
    assert.equal((await call('/api/export')).status,401);
    const index = await call('/'); assert.equal(index.status,200); assert.match(index.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    assert.equal((await call('/workspace.js')).status,200);
    assert.equal((await call('/api/login','POST',{username:'test',password},{...headers,Origin:'https://attacker.example'})).status,403);
    assert.equal((await call('/api/login','POST',{username:'test',password:'wrong'})).status,401);
    const login = await call('/api/login','POST',{username:'test',password}); assert.equal(login.status,200);
    const session = await login.json(); const cookie = login.headers.get('set-cookie');
    assert.match(cookie,/HttpOnly/); assert.match(cookie,/SameSite=Strict/);
    headers.Cookie = cookie.split(';')[0];
    const data = await (await call('/api/data')).json();
    assert.equal((await call('/api/tasks','POST',{title:'CSRF fail',list_id:data.lists[0].id})).status,403);
    assert.equal((await call('/api/groups','POST',{name:'CSRF fail',list_id:data.lists[0].id})).status,403);
    headers['X-CSRF-Token'] = session.csrf;
    assert.equal((await call('/api/groups','POST',{name:'This week',list_id:data.lists[0].id,color:'#579bfc'})).status,201);
    assert.equal((await call('/api/import','POST',{groups:[{}],tasks:[]})).status,400);
    const created = await call('/api/tasks','POST',{title:'<script>no HTML injection</script>',list_id:data.lists[0].id}); assert.equal(created.status,201);
    const task = await created.json();
    assert.equal((await call(`/api/tasks/${task.id}/updates`,'POST',{text_body:'First update'},{...headers,'X-CSRF-Token':''})).status,403);
    assert.equal((await call(`/api/tasks/${task.id}/updates`,'POST',{text_body:'  '})).status,400);
    const posted=await call(`/api/tasks/${task.id}/updates`,'POST',{text_body:'First update'});assert.equal(posted.status,201);
    assert.equal((await posted.json()).item_source_id,`daybook:${task.id}`);
    assert.equal((await call(`/api/tasks/${task.id}`,'PATCH',{status:'done',assignee:'test',category:'This week',version:task.version})).status,200);
    assert.equal((await call(`/api/tasks/${task.id}`,'PATCH',{status:'todo',version:task.version})).status,409);
    const exported = await (await call('/api/export')).json(); assert.equal(exported.tasks.length,1); assert.ok(exported.tasks[0].completed_at); assert.equal(exported.users,undefined);
    assert.equal(exported.groups[0].name,'This week'); assert.equal(exported.tasks[0].assignee,'test');
    assert.equal(exported.updates.length,1);assert.equal(exported.updates[0].text_body,'First update');
    const uploaded=await call('/api/uploads','POST',{name:'notes.txt',bytes:Buffer.from('Attachment test').toString('base64')});assert.equal(uploaded.status,201);
    const asset=await uploaded.json();
    const photoUpdate=await call(`/api/tasks/${task.id}/updates`,'POST',{text_body:'',assets:[asset]});assert.equal(photoUpdate.status,201);
    assert.equal((await photoUpdate.json()).assets[0].name,'notes.txt');
    const downloaded=await call(`/api/assets/${asset.id}.txt`);assert.equal(downloaded.status,200);assert.equal(await downloaded.text(),'Attachment test');
    assert.equal((await call('/api/uploads','POST',{name:'unsafe.html',bytes:Buffer.from('<script>').toString('base64')})).status,400);
    const parent=await (await call('/api/tasks','POST',{title:'Parent',list_id:data.lists[0].id,checklist:[{id:'child-one',title:'Child',done:false}]})).json();
    const childPost=await call(`/api/tasks/${parent.id}/subitems/child-one/updates`,'POST',{text_body:'Child update',assets:[asset]});assert.equal(childPost.status,201);
    assert.equal((await childPost.json()).item_source_id,'daybook:child-one');
    assert.equal((await call(`/api/tasks/${parent.id}/subitems/missing/updates`,'POST',{text_body:'No child'})).status,404);
    assert.equal((await call('/api/import','POST',{tasks:[{title:'Bad date',list_id:data.lists[0].id,due_date:'2026-02-30'}]})).status,400);
    const badJson = await fetch(base+'/api/tasks',{method:'POST',headers,body:'['}); assert.equal(badJson.status,400);
    const sessionRow = app.store.get('SELECT * FROM sessions LIMIT 1'); assert.notEqual(sessionRow.token_hash,headers.Cookie.split('=')[1]);
    await new Promise(r=>app.server.close(r)); app.store.db.close();
    const restarted = createApp({dbPath,publicUrl:'http://127.0.0.1:8098/tasks',port:0});
    await new Promise(r=>restarted.server.listen(0,'127.0.0.1',r));
    const url = `http://127.0.0.1:${restarted.server.address().port}/tasks/api/`;
    try {
      assert.equal((await fetch(url+'session',{headers})).status,200);
    assert.equal((await (await fetch(url+'data',{headers})).json()).updates.some(u=>u.text_body==='Child update'),true);
      assert.equal((await fetch(url+`assets/${asset.id}.txt`,{headers})).status,200);
      assert.equal((await fetch(url+'logout',{method:'POST',headers,body:'{}'})).status,200);
      assert.equal((await fetch(url+'data',{headers})).status,401);
    } finally { await new Promise(r=>restarted.server.close(r)); restarted.store.db.close(); }
  } finally { if (app.server.listening) await new Promise(r=>app.server.close(r)); if (app.store.db.isOpen) app.store.db.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('startup removes expired trash attachments from disk',()=>{
  const dir=mkdtempSync(join(tmpdir(),'daybook-expired-assets-')),dbPath=join(dir,'test.sqlite'),uploadRoot=join(dir,'upload-assets');
  let store=openStore(dbPath);
  try{
    const board=store.addList({name:'Old attachments'}),task=store.insert({title:'Old item',list_id:board.id});
    const asset={id:'local-44444444-4444-4444-8444-444444444444',name:'old.txt',file_extension:'txt'};
    store.addUpdate(task.id,{assets:[asset]},'Owner');
    mkdirSync(uploadRoot);writeFileSync(join(uploadRoot,`${asset.id}.txt`),'expired');
    store.run('UPDATE tasks SET deleted_at=? WHERE id=?','2020-01-01T00:00:00.000Z',task.id);
    store.db.close();store=null;
    const app=createApp({dbPath,port:0});
    try{
      assert.equal(app.store.findTask(task.id),null);
      assert.equal(app.store.snapshot().updates.length,0);
      assert.equal(existsSync(join(uploadRoot,`${asset.id}.txt`)),false);
    }finally{app.store.db.close();}
  }finally{if(store?.db.isOpen)store.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('production refuses plain HTTP configuration', () => {
  assert.throws(()=>createApp({production:true,publicUrl:'http://example.com'}),/HTTPS/);
});
