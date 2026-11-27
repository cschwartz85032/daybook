import { randomUUID } from 'node:crypto';
import { pendingInvitation, issueSetupCode } from './enrollment.mjs';
import { InputError } from './store.mjs';
import { SmsProviderError, smsFailureReason } from './twilio/provider-errors.mjs';

const hour=3600000;
const ranks={accepted:1,scheduled:1,queued:2,sending:3,sent:4,delivered:5,undelivered:5,failed:5,canceled:5};
const terminal=new Set(['delivered','undelivered','failed','canceled']);
export const smsCallbackPath='/api/twilio/status/';
// Invited phone accounts are stored in E.164 format. Legacy numeric usernames are independent.
export const mobileAccount = username => typeof username==='string' && /^\+[1-9]\d{7,14}$/.test(username);

export function invitationSms(store,provider,publicUrl) {
  const base=publicUrl.href.replace(/\/?$/,'/');
  const describe = row => {
    if (!row) return null;
    const state=row.state==='submitting' && Date.now()-row.created_at>60000 ? 'unknown' : row.state;
    const failed=['failed','undelivered'].includes(state);
    return {state,reason:failed?smsFailureReason(row.error_code):null,
      ...(failed && row.error_code==='30034'?{manual_setup:true}:{})};
  };
  const latest = id => describe(store.get('SELECT * FROM invitation_texts WHERE invitation_id=? ORDER BY created_at DESC LIMIT 1',id));

  // The signed callback can arrive before messages.create returns. Bind both to the same attempt.
  function record(id,sid,state,errorCode=null) {
    if (!Object.hasOwn(ranks,state) || !/^SM[0-9a-f]{32}$/i.test(sid||'')) return false;
    const row=store.get('SELECT state,message_sid FROM invitation_texts WHERE id=?',id);
    if (!row || (row.message_sid && row.message_sid!==sid)) return false;
    if (terminal.has(row.state) || ranks[row.state]>ranks[state]) return true;
    const code=/^\d{1,6}$/.test(String(errorCode))?String(errorCode):null;
    store.run('UPDATE invitation_texts SET message_sid=?,state=?,error_code=? WHERE id=?',sid,state,code,id);
    return true;
  }

  async function send(boardId,id,actor) {
    if (!provider) throw new InputError('Daybook text delivery is not configured.',503);
    const invitation=pendingInvitation(store,id);
    if (invitation?.list_id!==boardId || !mobileAccount(invitation.username)) throw new InputError('Pending mobile invitation unavailable.',404);
    const attempt=randomUUID(), now=Date.now();
    const setup=store.transaction(()=>{
      const last=store.get('SELECT created_at FROM invitation_texts WHERE recipient=? ORDER BY created_at DESC LIMIT 1',invitation.user_id);
      if (last && now-last.created_at<60000) throw new InputError('Wait a minute before sending another text to this number.',429);
      const counts=store.get(`SELECT count(*) AS total,count(*) FILTER(WHERE actor=?) AS actor,
        count(*) FILTER(WHERE recipient=?) AS recipient FROM invitation_texts WHERE created_at>?`,actor,invitation.user_id,now-hour);
      if (counts.actor>=30 || counts.recipient>=5 || counts.total>=150) throw new InputError('Text limit reached. Try again in an hour.',429);
      store.run('DELETE FROM invitation_texts WHERE created_at<? AND NOT EXISTS (SELECT 1 FROM board_members m WHERE m.id=invitation_texts.invitation_id AND m.state=\'pending\')',now-30*24*hour);
      store.run('INSERT INTO invitation_texts(id,invitation_id,actor,recipient,created_at,state) VALUES(?,?,?,?,?,?)',attempt,id,actor,invitation.user_id,now,'submitting');
      return invitation.needs_setup ? issueSetupCode(store,boardId,id) : null;
    });
    const link=new URL(base);
    link.searchParams.set('board',boardId);
    link.searchParams.set('invite',id);
    const body='Daybook board invitation: '+link.href+(setup?' Setup code: '+setup.code+' (30 minutes).':' Sign in to accept.')+' Reply STOP to opt out.';
    let message;
    try {
      message=await provider.send({to:invitation.username,body,statusCallback:base+smsCallbackPath.slice(1)+attempt});
    } catch (error) {
      const state=error instanceof SmsProviderError && !error.uncertain?'failed':'unknown';
      store.run("UPDATE invitation_texts SET state=?,error_code=? WHERE id=? AND state='submitting'",state,error instanceof SmsProviderError?error.code:null,attempt);
    }
    if (message) record(attempt,message.messageId,Object.hasOwn(ranks,message.status)?message.status:'accepted');
    return describe(store.get('SELECT * FROM invitation_texts WHERE id=?',attempt));
  }
  return {send,latest,record};
}
