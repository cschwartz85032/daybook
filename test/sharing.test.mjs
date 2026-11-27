import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.mjs';
import {setAccount} from '../scripts/account.mjs';
import {openStore} from '../lib/store.mjs';

test('named board invitations, scoped data, delegated roles, and live revocation', async t => {
  const dir = mkdtempSync(join(tmpdir(),'daybook-sharing-'));
  const dbPath = join(dir,'boards.sqlite');
  const password = 'Automated account fixture 123';
  await setAccount(dbPath,'owner',password);
  for (const name of ['editor','viewer','friend','pending']) await setAccount(dbPath,name,password,{member:true});
  const origin = 'http://127.0.0.1:8098';
  const app = createApp({dbPath,publicUrl:origin+'/daybook'});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{
    await new Promise(r=>app.server.close(r));
    app.store.db.close();
    rmSync(dir,{recursive:true,force:true});
  });
  const api = 'http://127.0.0.1:'+app.server.address().port+'/daybook/api/';
  async function signIn(username) {
    const headers = {'Content-Type':'application/json',Origin:origin};
    async function call(path,method='GET',body) {
      return fetch(api+path,{method,headers,body:JSON.stringify(body)});
    }
    const login = await call('login','POST',{username,password});
    assert.equal(login.status,200);
    headers.Cookie = login.headers.get('set-cookie').split(';')[0];
    headers['X-CSRF-Token'] = (await login.json()).csrf;
    return call;
  }
  const owner = await signIn('owner'), editor = await signIn('editor'), viewer = await signIn('viewer');
  const friend = await signIn('friend'), pending = await signIn('pending');
  const [shared,privateBoard] = (await (await owner('data')).json()).lists;
  const members = 'lists/'+shared.id+'/members';
  const remember=(actor,list_id)=>actor('preferences/last-board','PATCH',{list_id});
  const saved=async actor=>(await (await actor('data')).json()).last_board_id;
  assert.equal(await saved(owner),null);
  assert.equal((await remember(owner,privateBoard.id)).status,200);
  assert.equal(await saved(await signIn('owner')),privateBoard.id);
  assert.equal((await remember(viewer,privateBoard.id)).status,404);
  assert.equal(await saved(viewer),null);
  const invite = async (actor,username,role='view',sharing=false) => {
    const res = await actor(members,'POST',{username,role,sharing});
    assert.equal(res.status,201);
    return (await res.json()).id;
  };
  const accept = (actor,id) => actor('invitations/'+id+'/accept','POST',{});
  const editorId = await invite(owner,'editor','edit',true);
  assert.equal((await accept(friend,editorId)).status,404);
  assert.deepEqual((await (await editor('data')).json()).lists,[]);
  assert.equal((await accept(editor,editorId)).status,200);
  const viewerId = await invite(editor,'viewer');
  assert.equal((await accept(viewer,viewerId)).status,200);
  assert.equal((await remember(viewer,shared.id)).status,200);
  assert.equal(await saved(viewer),shared.id);
  assert.equal(await saved(owner),privateBoard.id);
  assert.equal((await (await viewer('export')).json()).last_board_id,undefined);
  assert.equal((await viewer(members,'POST',{username:'friend'})).status,403);
  assert.equal((await editor(members,'POST',{username:'friend',role:'view',sharing:true})).status,403);
  assert.equal((await owner(members+'/'+viewerId,'PATCH',{sharing:true})).status,200);
  assert.equal((await viewer(members,'POST',{username:'friend',role:'edit'})).status,403);
  const friendId = await invite(viewer,'friend');
  assert.equal((await accept(friend,friendId)).status,200);
  const pendingId = await invite(viewer,'pending');

  const privateTask = await (await owner('tasks','POST',{list_id:privateBoard.id,title:'Private task'})).json();
  const task = await (await editor('tasks','POST',{list_id:shared.id,title:'Shared task'})).json();
  async function attach(actor,task,text) {
    const res = await actor('uploads','POST',{list_id:task.list_id,name:'file.txt',bytes:Buffer.from(text).toString('base64')});
    assert.equal(res.status,201);
    const file = await res.json();
    assert.equal((await actor('tasks/'+task.id+'/updates','POST',{assets:[file],text_body:text})).status,201);
    return file;
  }
  const sharedFile = await attach(editor,task,'Shared file');
  const privateFile = await attach(owner,privateTask,'Private file');
  const filePath = file=>'assets/'+file.id+'.txt';
  for (const path of ['data','export']) {
    const result = await (await viewer(path)).json();
    assert.deepEqual(result.lists.map(b=>b.id),[shared.id]);
    assert.deepEqual(result.tasks.map(t=>t.id),[task.id]);
    assert.deepEqual(result.updates.map(u=>u.text_body),['Shared file']);
  }
  assert.equal((await viewer(filePath(sharedFile))).status,200);
  assert.equal((await viewer(filePath(privateFile))).status,404);
  assert.equal((await editor('tasks/'+task.id+'/updates','POST',{assets:[privateFile]})).status,400);
  assert.equal((await viewer('tasks/'+task.id,'PATCH',{title:'Changed',version:1})).status,403);
  assert.equal((await editor('tasks/'+task.id,'PATCH',{list_id:privateBoard.id,version:1})).status,404);
  assert.equal((await editor('lists/'+shared.id,'PATCH',{version:1,deleted:true})).status,403);
  assert.equal((await editor('import','POST',{tasks:[]})).status,403);
  assert.equal((await editor(members+'/'+viewerId,'PATCH',{remove:true})).status,403);

  assert.equal((await owner(members+'/'+editorId,'PATCH',{role:'view'})).status,200);
  assert.equal((await editor('tasks/'+task.id+'/updates','POST',{text_body:'Edit'})).status,403);
  assert.equal((await owner(members+'/'+viewerId,'PATCH',{remove:true})).status,200);
  assert.equal(await saved(viewer),null);
  assert.equal((await remember(viewer,shared.id)).status,404);
  assert.equal((await viewer(filePath(sharedFile))).status,404);
  assert.deepEqual((await (await viewer('export')).json()).lists,[]);
  assert.equal((await accept(viewer,viewerId)).status,404);
  assert.equal((await accept(pending,pendingId)).status,404);
  assert.equal((await editor(members,'POST',{username:'viewer'})).status,403);
  assert.deepEqual((await (await friend('data')).json()).lists.map(b=>b.id),[shared.id]);
  const replacement = await invite(owner,'viewer');
  assert.notEqual(replacement,viewerId);
  assert.equal((await accept(viewer,viewerId)).status,404);
  assert.equal((await accept(viewer,replacement)).status,200);
  assert.equal((await owner('lists/'+privateBoard.id,'PATCH',{version:privateBoard.version,deleted:true})).status,200);
  assert.equal(await saved(owner),null);
  assert.equal((await remember(owner,privateBoard.id)).status,404);
});

test('upgrade attributes existing board content and imported child updates to the original owner’s boards', async t => {
  const dir = mkdtempSync(join(tmpdir(),'daybook-sharing-upgrade-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path = join(dir,'old.sqlite');
  await setAccount(path,'original-owner','Owner password fixture');
  let store = openStore(path);
  const [board,other] = store.snapshot().lists;
  const task = store.insert({title:'Imported',list_id:board.id,checklist:[{id:'1234',done:false,title:'Child'}]});
  store.addSubitemUpdate(task.id,'1234',{text_body:'Existing child update'},'Author');
  store.db.exec('DROP TABLE workspace_owner; DROP INDEX item_updates_list; ALTER TABLE item_updates DROP COLUMN list_id; PRAGMA user_version=10');
  store.db.close();
  store = openStore(path);
  try {
    assert.equal(store.get('SELECT username FROM users JOIN workspace_owner ON users.id=workspace_owner.user_id').username,'original-owner');
    assert.equal(store.snapshot([other.id]).updates.length,0);
    assert.equal(store.snapshot([board.id]).updates[0].text_body,'Existing child update');
    store.update(task.id,{version:1,list_id:other.id});
    assert.equal(store.snapshot([board.id]).updates.length,0);
    assert.equal(store.snapshot([other.id]).updates.length,1);
  } finally {store.db.close();}
});
