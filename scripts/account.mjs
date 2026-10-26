import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createInterface, emitKeypressEvents } from 'node:readline';
import { openStore } from '../lib/store.mjs';
import { passwordHash, token } from '../lib/auth.mjs';

export async function setAccount(dbPath, username, password) {
  if (!/^[a-zA-Z0-9._@-]{1,80}$/.test(username)) throw new Error('Use a username with letters, numbers, dots, dashes, @, or underscores.');
  if (typeof password !== 'string' || password.length < 14 || password.length > 1024) throw new Error('Use a password with 14–1024 characters.');
  const store = openStore(dbPath);
  try {
    const salt = token(); const hash = await passwordHash(password, salt);
    const user = store.get('SELECT * FROM users LIMIT 1');
    store.transaction(() => {
      if (user) store.run('UPDATE users SET username=?,salt=?,password_hash=? WHERE id=?', username, salt, hash, user.id);
      else store.run('INSERT INTO users VALUES(?,?,?,?)', randomUUID(), username, salt, hash);
      store.run('DELETE FROM sessions');
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
    await setAccount(process.env.DB_PATH || resolve('data/daybook.sqlite'), username, password);
    console.log('Account saved. Existing sessions have been signed out.');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
