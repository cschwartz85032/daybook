import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.mjs';
import {setAccount} from '../scripts/account.mjs';
import {contactAddress} from '../lib/contact.mjs';

test('contact identifiers are normalized without merging distinct email addresses',()=>{
  assert.equal(contactAddress('  Pat+Board@Example.TEST ').address,'pat+board@example.test');
  assert.equal(contactAddress('(602) 555-0100').address,'+16025550100');
  assert.equal(contactAddress('1-602-555-0100').address,'+16025550100');
  assert.equal(contactAddress('+44 7700 900123').address,'+447700900123');
  for (const input of ['name@','a..b@example.com','a@example..com','555-0100','12call345',{}]) assert.equal(contactAddress(input),null);
});

test('first-time recipients activate by contact and code, with revocation and delegated invitations',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'daybook-onboarding-')), dbPath=join(dir,'daybook.sqlite');
  const password='Daybook enrollment test password';
  await setAccount(dbPath,'owner',password);
  const origin='http://127.0.0.1:8098',app=createApp({dbPath,publicUrl:origin+'/daybook',smsProvider:null});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(r=>app.server.close(r));app.store.db.close();rmSync(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+app.server.address().port+'/daybook/api/';
  async function call(path,body,headers={},method=body===undefined?'GET':'POST') {
    return fetch(base+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  }
  async function signedIn(response) {
    assert.equal(response.status,200);
    const {csrf}=await response.json();
    return {Cookie:response.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':csrf};
  }
  const owner=await signedIn(await call('login',{username:'owner',password}));
  const [board,other]=app.store.snapshot().lists;
  const members='lists/'+board.id+'/members', otherMembers='lists/'+other.id+'/members';
  async function invite(path,contact,actor,settings={}) {
    const response=await call(path,{contact,...settings},actor);
    assert.equal(response.status,201);
    return response.json();
  }
  const address='kim+work@example.test', number='+16025550123';
  const kim=await invite(members,address.toUpperCase(),owner,{role:'edit',sharing:true});
  assert.equal(kim.setup.contact,address);
  const second=await invite(otherMembers,address,owner);
  assert.equal(second.needs_setup,true);
  assert.equal(app.store.get('SELECT count(*) AS n FROM users').n,2);
  const enter=id=>'invitations/'+id+'/activate';
  const enroll={password,contact:address,code:kim.setup.code};
  assert.equal((await call('login',{username:address,password})).status,401);
  assert.deepEqual(await (await call('invitations/'+kim.id+'/entry')).json(),{needs_setup:true});
  assert.equal((await call(enter(kim.id),{...enroll,contact:'someone@example.test'})).status,400);
  assert.equal((await call(enter(second.id),enroll)).status,400);
  assert.equal((await call(enter(kim.id),enroll,owner)).status,409);
  const kimSession=await signedIn(await call(enter(kim.id),enroll));
  assert.equal((await call(enter(kim.id),enroll)).status,400);
  assert.equal((await call(enter(second.id),{...enroll,code:second.setup.code})).status,400);
  const snapshot=await (await call('data',undefined,kimSession)).json();
  assert.deepEqual(snapshot.lists.map(b=>b.id),[board.id]);
  assert.deepEqual(snapshot.invitations.map(i=>i.id),[second.id]);
  await signedIn(await call('login',{username:address.toUpperCase(),password}));
  const phone=await invite(members,'(602) 555-0123',kimSession);
  assert.equal(phone.needs_setup,true); assert.equal(phone.setup,undefined);
  const issue=members+'/'+phone.id+'/setup-code';
  assert.equal((await call(issue,{},kimSession)).status,403);
  const original=await (await call(issue,{},owner)).json();
  const replacement=await (await call(issue,{},owner)).json();
  const claim=code=>call(enter(phone.id),{contact:number,code,password});
  assert.equal((await claim(original.code)).status,400);
  app.store.run('UPDATE setup_codes SET expires=0 WHERE invitation_id=?',phone.id);
  assert.equal((await claim(replacement.code)).status,400);
  const last=await (await call(issue,{},owner)).json();
  assert.equal((await call(members+'/'+phone.id,{remove:true},owner,'PATCH')).status,200);
  assert.equal((await claim(last.code)).status,400);
  const reissued=await invite(members,number,owner);
  await signedIn(await call(enter(reissued.id),{contact:'602 555 0123',code:reissued.setup.code,password}));
  await signedIn(await call('login',{username:'(602) 555-0123',password}));
  const after=await invite(otherMembers,number,owner);
  assert.equal(after.needs_setup,false); assert.equal(after.setup,undefined);
  assert.equal(app.store.get('SELECT count(*) AS n FROM users').n,3);
  assert.equal((await call(members,{contact:'invalid-contact'},owner)).status,400);
  assert.equal((await call(members,{contact:'invalid-role@example.test',role:'owner'},owner)).status,400);
  assert.equal(app.store.get('SELECT count(*) AS n FROM users').n,3);
});
