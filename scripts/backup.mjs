import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
const source = process.env.DB_PATH || resolve('data/daybook.sqlite');
const directory = resolve(process.env.BACKUP_DIR || 'backups');
mkdirSync(directory,{recursive:true,mode:0o700});
const path = join(directory,`daybook-${new Date().toISOString().replace(/[:.]/g,'-')}.sqlite`);
const db = new DatabaseSync(source,{readOnly:true});
try {
  await backup(db,path);
  chmodSync(path,0o600);
  const check = new DatabaseSync(path,{readOnly:true});
  try { if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Backup integrity check failed.'); }
  finally {check.close();}
  console.log(path);
} finally {db.close();}
