import { randomBytes, timingSafeEqual } from 'node:crypto';
import { digest } from './auth.mjs';
import { contactAddress } from './contact.mjs';
import { InputError } from './store.mjs';

export function pendingInvitation(store,id) {
  return store.get(`SELECT m.id,m.user_id,m.list_id,m.invited_by,m.role,u.username,p.user_id IS NOT NULL AS needs_setup
    FROM board_members m JOIN lists b ON b.id=m.list_id JOIN users u ON u.id=m.user_id
    LEFT JOIN pending_accounts p ON p.user_id=u.id
    WHERE m.id=? AND b.deleted_at IS NULL AND m.state='pending'`,id);
}

export function issueSetupCode(store,boardId,id) {
  const invitation = pendingInvitation(store,id);
  if (!invitation?.needs_setup || invitation.list_id!==boardId) throw new InputError('This invitation does not need account setup.',409);
  const code = randomBytes(6).toString('hex').toUpperCase();
  store.run(`INSERT INTO setup_codes(invitation_id,code_hash,expires) VALUES(?,?,?)
    ON CONFLICT(invitation_id) DO UPDATE SET code_hash=excluded.code_hash,expires=excluded.expires,failures=0`,
    id,digest(id+code),Date.now()+30*60000);
  return {contact:invitation.username,code:code.match(/.{4}/g).join('-')};
}

export function verifySetupCode(store,id,contact,code) {
  const invitation = pendingInvitation(store,id);
  const saved = store.get('SELECT * FROM setup_codes WHERE invitation_id=?',id);
  const invalid = () => new InputError('Check the contact and setup code, or ask the board owner for a new code.',400);
  if (!invitation?.needs_setup || !saved || saved.expires<=Date.now() || saved.failures>=8) throw invalid();
  const value = typeof code==='string' && code.length<=32 ? code.replace(/[-\s]/g,'').toUpperCase() : '';
  if (!timingSafeEqual(Buffer.from(digest(id+value),'hex'),Buffer.from(saved.code_hash,'hex')) ||
      invitation.username !== contactAddress(contact)?.address) {
    store.run('UPDATE setup_codes SET failures=failures+1 WHERE invitation_id=?',id);
    throw invalid();
  }
  return invitation;
}
