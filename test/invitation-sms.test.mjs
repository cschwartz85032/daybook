import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import twilio from 'twilio';
import {createApp} from '../server.mjs';
import {setAccount} from '../scripts/account.mjs';
import {twilioProvider} from '../lib/twilio/provider.mjs';
import {mobileAccount} from '../lib/invitation-sms.mjs';

const settings={
  DAYBOOK_TWILIO_ACCOUNT_SID:'AC'+'a'.repeat(32),
  DAYBOOK_TWILIO_AUTH_TOKEN:'test-token',
  DAYBOOK_TWILIO_MESSAGING_SERVICE_SID:'MG'+'b'.repeat(32),
  DAYBOOK_TWILIO_FROM_NUMBER:'+16025550100',
};

test('Twilio uses the configured sender and leaves unconfigured installations on manual delivery',async()=>{
  assert.equal(twilioProvider({}),null);
  assert.throws(()=>twilioProvider({DAYBOOK_TWILIO_AUTH_TOKEN:'test'}),/settings/);
  assert.equal(mobileAccount('6025550101'),false);
  for (const withService of [false,true]) {
    let actual;
    const provider=twilioProvider({...settings,DAYBOOK_TWILIO_MESSAGING_SERVICE_SID:withService?settings.DAYBOOK_TWILIO_MESSAGING_SERVICE_SID:''},(sid,token,options)=>{
      assert.equal(sid,settings.DAYBOOK_TWILIO_ACCOUNT_SID);
      assert.equal(options.autoRetry,false);
      return {messages:{create:async fields=>{actual=fields;return {sid:'SM'+'c'.repeat(32),status:'queued'};}}};
    });
    const text={to:'+16025550101',body:'Test',statusCallback:'https://daybook.example/status'};
    await provider.send(text);
    assert.deepEqual(actual,{...text,from:settings.DAYBOOK_TWILIO_FROM_NUMBER,...(withService?{messagingServiceSid:settings.DAYBOOK_TWILIO_MESSAGING_SERVICE_SID}:{})});
  }
});

test('mobile invites, signed delivery receipts, resends and activation through the board API',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'daybook-texts-')),dbPath=join(dir,'daybook.sqlite');
  const password='A Daybook test password';
  await setAccount(dbPath,'owner',password);
  const messages=[];
  let onSubmit;
  const provider=twilioProvider({...settings,DAYBOOK_TWILIO_FROM_NUMBER:''},()=>({messages:{create:async fields=>{
    const message={...fields,sid:'SM'+(messages.length+1).toString(16).padStart(32,'0')};
    messages.push(message);
    await onSubmit?.(message);
    return {sid:message.sid,status:'queued'};
  }}}));
  const origin='https://daybook.example',app=createApp({dbPath,publicUrl:origin+'/boards',smsProvider:provider});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{await new Promise(r=>app.server.close(r));app.store.db.close();rmSync(dir,{recursive:true,force:true});});
  const local='http://127.0.0.1:'+app.server.address().port;
  function call(path,payload,headers={},method=payload===undefined?'GET':'POST') {
    return fetch(local+'/boards/api/'+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(payload)});
  }
  async function login(response) {
    assert.equal(response.status,200);
    const {csrf}=await response.json();
    return {Cookie:response.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':csrf};
  }
  async function receipt(message,state,extra={},signed=true) {
    const fields={AccountSid:settings.DAYBOOK_TWILIO_ACCOUNT_SID,MessageSid:message.sid,MessageStatus:state,...extra};
    const signature=twilio.getExpectedTwilioSignature(settings.DAYBOOK_TWILIO_AUTH_TOKEN,message.statusCallback,fields);
    return fetch(local+new URL(message.statusCallback).pathname,{method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded','X-Twilio-Signature':signed?signature:'bad'},body:new URLSearchParams(fields)});
  }
  const owner=await login(await call('login',{username:'owner',password}));
  const [board,other]=app.store.snapshot().lists;
  const members='lists/'+board.id+'/members',others='lists/'+other.id+'/members';
  const delegateNumber='+16025550101',recipient='+16025550102';
  const codeOf=message=>message.body.match(/Setup code: ([A-F0-9-]+)/)[1];
  const activate=(id,contact,code)=>call('invitations/'+id+'/activate',{contact,code,password});
  const invite=async(path,body,actor)=>{
    const res=await call(path,body,actor);
    assert.equal(res.status,201);
    return res.json();
  };
  onSubmit=async message=>{assert.equal((await receipt(message,'delivered')).status,204);};
  const delegateInvite=await invite(members,{contact:'(602) 555-0101',role:'view',sharing:true},owner);
  assert.equal(delegateInvite.sms.state,'delivered');
  assert.equal(delegateInvite.setup,undefined);
  assert.equal(messages[0].to,delegateNumber);
  assert.ok(messages[0].body.includes(origin+'/boards/?board='+board.id+'&invite='+delegateInvite.id));
  const delegate=await login(await activate(delegateInvite.id,delegateNumber,codeOf(messages[0])));
  onSubmit=undefined;
  assert.equal((await call(members,{contact:recipient,role:'edit'},delegate)).status,403);
  const child=await invite(members,{contact:recipient},delegate);
  assert.equal(child.sms.state,'queued');
  assert.equal(child.setup,undefined);
  const resend=members+'/'+child.id+'/text';
  assert.equal((await call(resend,{},delegate)).status,429);
  assert.equal((await call(members+'/'+child.id+'/setup-code',{},owner)).status,409);
  assert.deepEqual((await (await call(members,undefined,delegate)).json()).map(m=>m.id),[child.id]);
  const message=messages[1];
  assert.equal((await receipt(message,'delivered',{},false)).status,403);
  assert.equal((await receipt(message,'delivered',{AccountSid:'AC'+'f'.repeat(32)})).status,403);
  assert.equal((await receipt(message,'delivered',{MessageSid:messages[0].sid})).status,400);
  assert.equal((await receipt(message,'sent')).status,204);
  assert.equal((await receipt(message,'queued')).status,204);
  assert.equal((await receipt(message,'undelivered',{ErrorCode:'21610'})).status,204);
  assert.equal((await receipt(message,'sent')).status,204);
  const [person]=await (await call(members,undefined,delegate)).json();
  assert.equal(person.sms.state,'undelivered');
  assert.match(person.sms.reason,/opted out/);
  const ageAttempts=()=>app.store.run('UPDATE invitation_texts SET created_at=created_at-61000');
  ageAttempts();
  const reply=await call(resend,{to:'+16025550999',body:'ignored'},delegate);
  assert.equal((await reply.json()).state,'queued');
  assert.equal(messages[2].to,recipient);
  assert.equal((await activate(child.id,recipient,codeOf(message))).status,400);
  assert.equal((await activate(child.id,recipient,codeOf(messages[2]))).status,200);
  assert.equal((await call(resend,{},delegate)).status,404);
  const existing=await invite(others,{contact:recipient},owner);
  assert.equal(existing.needs_setup,false);
  assert.equal(existing.sms.state,'limited');
  ageAttempts();
  await call(others+'/'+existing.id+'/text',{},owner);
  assert.doesNotMatch(messages.at(-1).body,/Setup code/);
  onSubmit=()=>{throw Object.assign(new Error('Private provider details'),{status:400,code:21614});};
  const failure=await invite(members,{contact:'+16025550103'},owner);
  assert.deepEqual(failure.sms,{state:'failed',reason:'The recipient number does not accept mobile texts.'});
  assert.equal((await call(members+'/'+failure.id+'/text',{},delegate)).status,404);
  onSubmit=()=>{throw new Error('network timeout');};
  const uncertain=await invite(members,{contact:'+16025550104'},delegate);
  assert.equal(uncertain.sms.state,'unknown');
  const total=messages.length;
  assert.equal((await call(members+'/'+delegateInvite.id,{sharing:false},owner,'PATCH')).status,200);
  assert.equal((await call(members+'/'+uncertain.id+'/text',{},delegate)).status,403);
  assert.equal((await call(members+'/'+uncertain.id+'/text',{},owner)).status,404);
  const email=await invite(members,{contact:'kim@example.test'},owner);
  assert.ok(email.setup.code);
  assert.equal(messages.length,total);
});
