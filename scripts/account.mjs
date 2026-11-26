import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createInterface, emitKeypressEvents } from 'node:readline';
import { openStore } from '../lib/store.mjs';
import { passwordHash, token } from '../lib/auth.mjs';
import { contactAddress } from '../lib/contact.mjs';

export async function setAccount(dbPath, username, password, { member = false } = {}) {
  const address=contactAddress(username)?.address;
  if (!address && !/^[a-zA-Z0-9._@-]{1,80}$/.test(username)) throw new Error('Enter a username, email address, or mobile number.');
  if (typeof password !== 'string' || password.length < 14 || password.length > 1024) throw new Error('Use a password with 14–1024 characters.');
  const store = openStore(dbPath);
  try {
    const salt = token(); const hash = await passwordHash(password, salt);
    store.transaction(() => {
      const owner = store.get('SELECT user_id FROM workspace_owner');
      const exact = store.get('SELECT id FROM users WHERE username=?',username);
      if (!exact && member && address) username=address;
      const existing = exact || store.get('SELECT id FROM users WHERE username=?',username);
      if (member && !owner) throw new Error('Create the owner account first.');
      if (member && existing?.id === owner?.user_id) throw new Error('Use the owner account command for this username.');
      if (!member && existing && existing.id !== owner?.user_id) throw new Error('That username belongs to a member.');
      const id = (member ? existing?.id : owner?.user_id) || randomUUID();
      store.run(`INSERT INTO users(id,username,salt,password_hash) VALUES(?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET username=excluded.username,salt=excluded.salt,password_hash=excluded.password_hash`,id,username,salt,hash);
      if (!member && !owner) store.run('INSERT INTO workspace_owner VALUES(1,?)',id);
      store.run('DELETE FROM pending_accounts WHERE user_id=?',id);
      store.run('DELETE FROM setup_codes WHERE invitation_id IN (SELECT id FROM board_members WHERE user_id=?)',id);
      store.run('DELETE FROM sessions WHERE user_id=?',id);
    });
  } finally { store.db.close(); }
}
async function hiddenPassword(prompt) {
  process.stdout.write(prompt);
  emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    function read(s, key) {
      if (key?.ctrl && key.name === 'c') { done(); reject(new Error('Cancelled.')); }
      else if (key?.name === 'return') { done(); resolve(value); }
      else if (key?.name === 'backspace') value = value.slice(0, -1);
      else if (s && !key?.ctrl && !key?.meta) value += s;
    }
    function done() { process.stdin.off('keypress', read); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); }
    process.stdin.on('keypress', read);
  });
}
if (process.argv[1]?.endsWith('account.mjs')) {
  try {
    let username, password;
    if (process.argv.includes('--stdin')) {
      let raw = ''; for await (const chunk of process.stdin) raw += chunk;
      ({ username, password } = JSON.parse(raw));
    } else {
      if (!process.stdin.isTTY) throw new Error('Use an interactive terminal, or --stdin with JSON.');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      username = await new Promise(r => rl.question('Username: ', r)); rl.close();
      password = await hiddenPassword('Password (14+ characters, hidden): ');
      if (password !== await hiddenPassword('Confirm password: ')) throw new Error('Passwords did not match.');
    }
    await setAccount(process.env.DB_PATH || resolve('data/daybook.sqlite'), username, password, {member:process.argv.includes('--member')});
    console.log('Account saved. This account’s existing sessions have been signed out.');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
