import { randomBytes, randomUUID } from 'node:crypto';
import { InputError } from './store.mjs';
import { contactAddress } from './contact.mjs';

const missing = () => new InputError('Board or invitation unavailable.', 404);
const denied = () => new InputError('Your board permission does not allow this action.', 403);

export function boardAccess(store, userId) {
  const {get, all, run} = store;
  const owner = get('SELECT user_id FROM workspace_owner')?.user_id === userId;
  const activeBoards = () => all(`SELECT m.list_id,m.role,m.sharing FROM board_members m
    JOIN lists b ON b.id=m.list_id WHERE m.user_id=? AND m.state='active' AND b.deleted_at IS NULL`, userId);

  function board(id, permission = 'view') {
    if (typeof id !== 'string') throw missing();
    const list = get('SELECT deleted_at FROM lists WHERE id=?',id);
    if (!list) throw missing();
    if (owner) return {role:'owner',sharing:true};
    const member = get("SELECT role,sharing FROM board_members WHERE list_id=? AND user_id=? AND state='active'",id,userId);
    if (!member || list.deleted_at) throw missing();
    if (permission === 'owner' || (permission === 'edit' && member.role !== 'edit') ||
        (permission === 'share' && !member.sharing)) throw denied();
    return member;
  }

  function snapshot(forExport) {
    const members = owner ? [] : activeBoards();
    const data = store.snapshot(owner ? undefined : members.map(m => m.list_id));
    if (forExport) return data;
    const byId = new Map(members.map(m => [m.list_id,m]));
    data.lists = data.lists.map(b => ({...b, role:owner ? 'owner' : byId.get(b.id).role,
      sharing:owner || Boolean(byId.get(b.id).sharing)}));
    data.workspace_owner = owner;
    data.invitations = all(`SELECT m.id,m.list_id,b.name,m.role,m.sharing,u.username AS inviter
      FROM board_members m JOIN lists b ON b.id=m.list_id JOIN users u ON u.id=m.invited_by
      WHERE m.user_id=? AND m.state='pending' AND b.deleted_at IS NULL ORDER BY b.name`,userId);
    return data;
  }

  function people(id) {
    board(id,'share');
    if (!owner) return [];
    return all(`SELECT m.id,u.username,i.username AS inviter,m.role,m.sharing,m.state,p.user_id IS NOT NULL AS needs_setup
      FROM board_members m JOIN users u ON u.id=m.user_id JOIN users i ON i.id=m.invited_by
      LEFT JOIN pending_accounts p ON p.user_id=m.user_id
      WHERE m.list_id=? AND m.state<>'removed' ORDER BY u.username`,id);
  }

  function validate(role, sharing) {
    if (!['view','edit'].includes(role) || typeof sharing !== 'boolean') throw new InputError('Choose a permission and sharing setting.');
  }

  function invite(id, {contact, username, role = 'view', sharing = false}) {
    const access = board(id,'share');
    validate(role,sharing);
    if (!owner && (sharing || (role === 'edit' && access.role === 'view'))) throw denied();
    const recipient = contact ?? username;
    if (typeof recipient !== 'string' || recipient.length > 254) throw new InputError('Enter an email address or mobile number.');
    const normalized = contactAddress(recipient);
    return store.transaction(() => {
      // Preserve exact legacy usernames, including numeric usernames, on the original API.
      let user = (contact === undefined || !normalized) && get('SELECT id FROM users WHERE username=?',recipient.trim());
      if (!user && normalized) user = get('SELECT id FROM users WHERE username=?',normalized.address);
      if (!user) {
        if (!normalized) throw new InputError('Enter a valid email address or mobile number. Include the country code for international numbers.');
        user = {id:randomUUID()};
        run('INSERT INTO users(id,username,salt,password_hash) VALUES(?,?,?,?)',user.id,normalized.address,randomUUID(),randomBytes(64).toString('hex'));
        run('INSERT INTO pending_accounts(user_id) VALUES(?)',user.id);
      }
      const needsSetup = Boolean(get('SELECT 1 FROM pending_accounts WHERE user_id=?',user.id));
      return inviteUser(id,user.id,role,sharing,needsSetup);
    });
  }

  function inviteUser(id, recipientId, role, sharing, needsSetup) {
    if (get('SELECT 1 FROM workspace_owner WHERE user_id=?',recipientId)) throw new InputError('The owner already has access.');
    const existing = get('SELECT state FROM board_members WHERE list_id=? AND user_id=?',id,recipientId);
    if (existing && existing.state !== 'removed') throw new InputError('This person already has access or a pending invitation.',409);
    if (existing && !owner) throw denied();
    const invitationId = randomUUID();
    run(`INSERT INTO board_members(id,list_id,user_id,invited_by,role,sharing,state) VALUES(?,?,?,?,?,?,'pending')
      ON CONFLICT(list_id,user_id) DO UPDATE SET id=excluded.id,invited_by=excluded.invited_by,
      role=excluded.role,sharing=excluded.sharing,state='pending'`,invitationId,id,recipientId,userId,role,Number(sharing));
    return {id:invitationId,needs_setup:needsSetup};
  }

  function manage(id, memberId, changes) {
    board(id,'owner');
    const member = get("SELECT * FROM board_members WHERE id=? AND list_id=? AND state<>'removed'",memberId,id);
    if (!member) throw missing();
    const role = changes.role ?? member.role;
    const sharing = changes.sharing ?? Boolean(member.sharing);
    validate(role,sharing);
    const state = changes.remove === true ? 'removed' : member.state;
    store.transaction(() => {
      if (state==='removed') run('DELETE FROM setup_codes WHERE invitation_id=?',memberId);
      run('UPDATE board_members SET role=?,sharing=?,state=? WHERE id=?',role,Number(sharing),state,memberId);
      // Accepted memberships are independent. Outstanding offers must stay within the inviter's authority.
      run(`DELETE FROM board_members WHERE list_id=? AND invited_by=? AND state='pending'
        AND (? OR (role='edit' AND ?='view'))`,id,member.user_id,Number(!sharing || state==='removed'),role);
    });
  }

  function accept(id) {
    const invitation = get(`SELECT m.list_id FROM board_members m JOIN lists b ON b.id=m.list_id
      WHERE m.id=? AND m.user_id=? AND m.state IN ('pending','active') AND b.deleted_at IS NULL`,id,userId);
    if (!invitation) throw missing();
    run("UPDATE board_members SET state='active' WHERE id=?",id);
    return invitation;
  }

  function asset(filename, boardId) {
    if (owner) return true;
    const ids = boardId ? [boardId] : activeBoards().map(m => m.list_id);
    return Boolean(get(`SELECT 1 FROM item_updates u, json_each(u.assets) a
      WHERE u.list_id IN (SELECT value FROM json_each(?)) AND
      CAST(json_extract(a.value,'$.id') AS TEXT)||'.'||lower(ltrim(json_extract(a.value,'$.file_extension'),'.'))=? LIMIT 1`,
    JSON.stringify(ids),filename));
  }

  function requireOwner() { if (!owner) throw denied(); }
  return {owner, board, requireOwner, people, invite, manage, accept, snapshot, asset};
}
