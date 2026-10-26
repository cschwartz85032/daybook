import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const STATUSES = ['todo', 'doing', 'waiting', 'done'];
export const PRIORITIES = ['none', 'low', 'medium', 'high'];
export const REPEATS = ['none', 'daily', 'weekdays', 'weekly', 'monthly'];
export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function today(timeZone = 'America/Phoenix', now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function validDate(value) {
  if (!value) return '';
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1900 || Number(value.slice(0, 4)) > 2200) throw new InputError('Use a valid date.');
  const parsed = new Date(value + 'T12:00:00Z');
  if (isNaN(parsed) || parsed.toISOString().slice(0, 10) !== value) throw new InputError('Use a valid date.');
  return value;
}
export function nextDate(base, repeat, currentDay) {
  let value = validDate(base || currentDay);
  do {
    const d = new Date(value + 'T12:00:00Z');
    if (repeat === 'monthly') {
      const day = d.getUTCDate();
      d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1);
      const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, last));
    } else {
      d.setUTCDate(d.getUTCDate() + (repeat === 'weekly' ? 7 : 1));
      if (repeat === 'weekdays') while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
    }
    value = d.toISOString().slice(0, 10);
  } while (value <= currentDay);
  return value;
}
function string(value, max, label, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new InputError(`${label} must be ${required ? '1–' : 'at most '}${max} characters.`);
  return value.trim();
}
function choice(value, values, label) {
  if (!values.includes(value)) throw new InputError(`Invalid ${label}.`);
  return value;
}

export function openStore(path, timeZone = 'America/Phoenix') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, salt TEXT NOT NULL, password_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS lists (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, list_id TEXT NOT NULL REFERENCES lists(id), title TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'none',
      due_date TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '', quantity TEXT NOT NULL DEFAULT '',
      repeat TEXT NOT NULL DEFAULT 'none', checklist TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT, deleted_at TEXT,
      source_id TEXT UNIQUE, next_task_id TEXT, version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS tasks_list ON tasks(list_id);
    CREATE INDEX IF NOT EXISTS tasks_due ON tasks(due_date);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
    CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS board_groups (
      id TEXT PRIMARY KEY, list_id TEXT NOT NULL REFERENCES lists(id), name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#579bfc', position INTEGER NOT NULL DEFAULT 0,
      UNIQUE(list_id,name)
    );
    CREATE TABLE IF NOT EXISTS item_updates (
      id TEXT PRIMARY KEY, item_source_id TEXT NOT NULL, creator TEXT NOT NULL,
      created_at TEXT NOT NULL, text_body TEXT NOT NULL DEFAULT '',
      assets TEXT NOT NULL DEFAULT '[]', replies TEXT NOT NULL DEFAULT '[]'
    );
    CREATE INDEX IF NOT EXISTS item_updates_item ON item_updates(item_source_id);
    CREATE TABLE IF NOT EXISTS automation_rules (
      id TEXT PRIMARY KEY, list_id TEXT NOT NULL REFERENCES lists(id), name TEXT NOT NULL,
      trigger_type TEXT NOT NULL, trigger_value TEXT NOT NULL DEFAULT '',
      action_type TEXT NOT NULL, action_value TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1, source_id TEXT UNIQUE, version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS automation_rules_list ON automation_rules(list_id);
    CREATE TABLE IF NOT EXISTS automation_events (
      id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
      task_id TEXT, event_key TEXT NOT NULL, description TEXT NOT NULL,
      created_at TEXT NOT NULL, UNIQUE(rule_id,event_key)
    );
    CREATE INDEX IF NOT EXISTS automation_events_created ON automation_events(created_at DESC);
    `);
  if (!db.prepare('PRAGMA table_info(tasks)').all().some(c => c.name === 'assignee')) {
    db.exec("ALTER TABLE tasks ADD COLUMN assignee TEXT NOT NULL DEFAULT ''");
  }
  if (!db.prepare('PRAGMA table_info(tasks)').all().some(c => c.name === 'external_data')) db.exec("ALTER TABLE tasks ADD COLUMN external_data TEXT NOT NULL DEFAULT '{}'");
  if (!db.prepare('PRAGMA table_info(lists)').all().some(c => c.name === 'source_id')) db.exec('ALTER TABLE lists ADD COLUMN source_id TEXT');
  if (!db.prepare('PRAGMA table_info(lists)').all().some(c => c.name === 'column_labels')) db.exec("ALTER TABLE lists ADD COLUMN column_labels TEXT NOT NULL DEFAULT '{}'");
  if (!db.prepare('PRAGMA table_info(lists)').all().some(c => c.name === 'status_settings')) db.exec("ALTER TABLE lists ADD COLUMN status_settings TEXT NOT NULL DEFAULT '{}'");
  if (!db.prepare('PRAGMA table_info(lists)').all().some(c => c.name === 'subitem_status_settings')) db.exec("ALTER TABLE lists ADD COLUMN subitem_status_settings TEXT NOT NULL DEFAULT '{}'");
  if (!db.prepare('PRAGMA table_info(lists)').all().some(c => c.name === 'deleted_at')) db.exec('ALTER TABLE lists ADD COLUMN deleted_at TEXT');
  if (!db.prepare('PRAGMA table_info(lists)').all().some(c => c.name === 'version')) db.exec('ALTER TABLE lists ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
  if (!db.prepare('PRAGMA table_info(board_groups)').all().some(c => c.name === 'version')) db.exec('ALTER TABLE board_groups ADD COLUMN version INTEGER NOT NULL DEFAULT 1');
  if (!db.prepare('PRAGMA table_info(tasks)').all().some(c => c.name === 'archived_at')) db.exec('ALTER TABLE tasks ADD COLUMN archived_at TEXT');
  if (!db.prepare('PRAGMA table_info(tasks)').all().some(c => c.name === 'converted_into')) db.exec('ALTER TABLE tasks ADD COLUMN converted_into TEXT');
  if (!db.prepare('PRAGMA table_info(tasks)').all().some(c => c.name === 'completed_on')) db.exec("ALTER TABLE tasks ADD COLUMN completed_on TEXT NOT NULL DEFAULT ''");
  if (!db.prepare('PRAGMA table_info(tasks)').all().some(c => c.name === 'order_position')) {
    db.exec('ALTER TABLE tasks ADD COLUMN order_position INTEGER NOT NULL DEFAULT 0');
    const rows = db.prepare('SELECT id,list_id,category FROM tasks ORDER BY list_id,category,created_at DESC,id').all();
    const setPosition = db.prepare('UPDATE tasks SET order_position=? WHERE id=?');
    let group = '', position = 0;
    for (const row of rows) {
      const key = JSON.stringify([row.list_id,row.category]);
      if (key !== group) { group = key; position = 0; }
      setPosition.run(position++, row.id);
    }
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS lists_source_id ON lists(source_id); CREATE INDEX IF NOT EXISTS tasks_order ON tasks(list_id,category,order_position); PRAGMA user_version=9');
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  if (!get('SELECT id FROM lists LIMIT 1')) transaction(() => {
    for (const [position, [name, color]] of [['Personal', '#548775'], ['Shopping', '#c4944d'], ['Household', '#8b78ae'], ['Morning routine', '#7795af']].entries())
      run('INSERT INTO lists(id,name,color,position) VALUES(?,?,?,?)', randomUUID(), name, color, position);
  });
  const decode = row => row ? { ...row, checklist: JSON.parse(row.checklist) } : null;
  const findTask = id => decode(get('SELECT * FROM tasks WHERE id=?', id));
  const firstPosition = (listId, category) => (get('SELECT MIN(order_position) AS position FROM tasks WHERE list_id=? AND category=?',listId,category)?.position ?? 1) - 1;
  function validateTask(input, existing = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Invalid task.');
    const t = { title: '', list_id: '', notes: '', status: 'todo', priority: 'none', due_date: '', category: '', quantity: '', repeat: 'none', checklist: [], assignee: '', external_data: '{}', ...existing, ...input };
    t.title = string(t.title, 500, 'Title', true);
    t.notes = string(t.notes, 50000, 'Notes');
    t.category = string(t.category, 100, 'Section');
    t.quantity = string(t.quantity, 100, 'Quantity');
    t.assignee = string(t.assignee, 80, 'Person');
    if (typeof t.list_id !== 'string' || !get('SELECT id FROM lists WHERE id=?', t.list_id)) throw new InputError('Choose an existing list.');
    const listSettings=get('SELECT status_settings,subitem_status_settings FROM lists WHERE id=?', t.list_id);
    const customStatuses = JSON.parse(listSettings?.status_settings || '{}');
    const subitemStatuses = JSON.parse(listSettings?.subitem_status_settings || '{}');
    if (!STATUSES.includes(t.status) && !(typeof t.status === 'string' && Object.hasOwn(customStatuses,t.status))) throw new InputError('Invalid status.');
    t.priority = choice(t.priority, PRIORITIES, 'priority');
    t.repeat = choice(t.repeat, REPEATS, 'repeat schedule');
    t.due_date = validDate(t.due_date);
    if (typeof t.external_data !== 'string' || t.external_data.length > 100000 || !t.external_data.trim().startsWith('{')) throw new InputError('Invalid source fields.');
    try { JSON.parse(t.external_data); } catch { throw new InputError('Invalid source fields.'); }
    if (!Array.isArray(t.checklist) || t.checklist.length > 1000) throw new InputError('A task can have up to 1,000 subitems.');
    t.checklist = t.checklist.map(c => {
      if (!c || typeof c !== 'object' || typeof c.done !== 'boolean') throw new InputError('Invalid subtask.');
      const status = c.status || (c.done ? 'done' : 'todo');
      if (!STATUSES.includes(status) && !(typeof status === 'string' && (Object.hasOwn(subitemStatuses,status)||Object.hasOwn(customStatuses,status)))) throw new InputError('Invalid subitem status.');
      return { id: typeof c.id === 'string' && c.id.length <= 80 ? c.id : randomUUID(), title: string(c.title, 500, 'Subtask', true), done: status === 'done' || subitemStatuses[status]?.done === true, status, status_touched: c.status_touched === true, status_blank: c.status_blank === true, archived_at: typeof c.archived_at === 'string' && !isNaN(Date.parse(c.archived_at)) ? c.archived_at : '', assignee: string(c.assignee || '', 80, 'Person'), due_date: validDate(c.due_date || ''), notes: string(c.notes || '', 50000, 'Subitem notes'), priority: choice(c.priority || 'none', PRIORITIES, 'priority'), source_id: c.source_id ? string(c.source_id, 300, 'Source ID') : '', external_data: typeof c.external_data === 'string' && c.external_data.length <= 100000 ? c.external_data : '{}' };
    });
    return t;
  }
  function insert(input) {
    const t = validateTask(input);
    const now = new Date().toISOString();
    const id = randomUUID();
    const source = input.source_id == null ? null : string(input.source_id, 300, 'Source ID', true);
    run(`INSERT INTO tasks(id,list_id,title,notes,status,priority,due_date,category,quantity,repeat,checklist,created_at,updated_at,completed_at,source_id,assignee,external_data,order_position)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, t.list_id, t.title, t.notes, t.status, t.priority, t.due_date, t.category, t.quantity, t.repeat, JSON.stringify(t.checklist), now, now, t.status === 'done' ? now : null, source, t.assignee, t.external_data, firstPosition(t.list_id,t.category));
    if(input.completed_on)run('UPDATE tasks SET completed_on=? WHERE id=?',validDate(input.completed_on),id);
    return findTask(id);
  }
  function update(id, input) {
    return transaction(() => {
      const old = findTask(id);
      if (!old) throw new InputError('Task not found.', 404);
      if (input.version !== old.version) throw new InputError('This task changed in another tab. Refresh and try again.', 409);
      if (old.deleted_at && input.deleted !== false) throw new InputError('Restore this task before editing it.');
      if ('deleted' in input && typeof input.deleted !== 'boolean') throw new InputError('Invalid deletion state.');
      if ('archived' in input && typeof input.archived !== 'boolean') throw new InputError('Invalid archive state.');
      const t = validateTask(input, old);
      const now = new Date().toISOString();
      let nextId = old.next_task_id;
      if (old.status !== 'done' && t.status === 'done' && t.repeat !== 'none' && !nextId && !input.deleted) {
        const next = insert({ ...t, source_id: null, status: 'todo', due_date: nextDate(t.due_date, t.repeat, today(timeZone)), checklist: t.checklist.map(c => ({ ...c, id: randomUUID(), done: false, status: 'todo' })) });
        nextId = next.id;
      }
      const position = old.list_id!==t.list_id || old.category!==t.category ? firstPosition(t.list_id,t.category) : old.order_position;
      run(`UPDATE tasks SET list_id=?,title=?,notes=?,status=?,priority=?,due_date=?,category=?,quantity=?,repeat=?,checklist=?,updated_at=?,completed_at=?,deleted_at=?,next_task_id=?,assignee=?,external_data=?,archived_at=?,order_position=?,version=version+1 WHERE id=?`,
        t.list_id, t.title, t.notes, t.status, t.priority, t.due_date, t.category, t.quantity, t.repeat, JSON.stringify(t.checklist), now,
        t.status === 'done' ? old.completed_at || now : null,
        input.deleted === true ? now : input.deleted === false ? null : old.deleted_at, nextId, t.assignee, t.external_data,
        input.archived === true ? now : input.archived === false ? null : old.archived_at, position, id);
      if(input.completed_on!==undefined)run('UPDATE tasks SET completed_on=? WHERE id=?',validDate(input.completed_on),id);
      if(old.status!==t.status&&!old.deleted_at&&!old.archived_at&&!input.deleted&&!input.archived)runStatusAutomations(id,old.status,t.status,now);
      return findTask(id);
    });
  }
  function addUpdate(taskId, input, creator) {
    if(!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Invalid update.');
    const textBody=string(input.text_body||'',50000,'Update text');
    const assets=Array.isArray(input.assets)?input.assets:[];
    if(!textBody&&!assets.length)throw new InputError('Write an update or attach a file.');
    if(assets.length>10||assets.some(a=>!a||typeof a!=='object'||typeof a.id!=='string'||!/^local-[a-f0-9-]{36}$/.test(a.id)||typeof a.name!=='string'||a.name.length>200||typeof a.file_extension!=='string'||!/^[a-z0-9]{1,8}$/.test(a.file_extension)))throw new InputError('Invalid update attachments.');
    const author=string(creator,100,'Update author',true);
    return transaction(()=>{
      const task=findTask(taskId);
      if(!task)throw new InputError('Item not found.',404);
      if(task.deleted_at||task.archived_at)throw new InputError('Restore this item before posting an update.');
      const id='daybook:'+randomUUID(),itemSourceId=task.source_id||'daybook:'+task.id,createdAt=new Date().toISOString();
      run('INSERT INTO item_updates(id,item_source_id,creator,created_at,text_body,assets) VALUES(?,?,?,?,?,?)',id,itemSourceId,author,createdAt,textBody,JSON.stringify(assets));
      return {id,item_source_id:itemSourceId,creator:author,created_at:createdAt,text_body:textBody,assets,replies:[]};
    });
  }
  function addSubitemUpdate(parentId,childId,input,creator){
    if(!input||typeof input!=='object'||Array.isArray(input))throw new InputError('Invalid update.');
    const textBody=string(input.text_body||'',50000,'Update text');
    const assets=Array.isArray(input.assets)?input.assets:[];
    if(!textBody&&!assets.length)throw new InputError('Write an update or attach a file.');
    if(assets.length>10||assets.some(a=>!a||typeof a!=='object'||typeof a.id!=='string'||!/^local-[a-f0-9-]{36}$/.test(a.id)||typeof a.name!=='string'||a.name.length>200||typeof a.file_extension!=='string'||!/^[a-z0-9]{1,8}$/.test(a.file_extension)))throw new InputError('Invalid update attachments.');
    const author=string(creator,100,'Update author',true);
    return transaction(()=>{
      const parent=findTask(parentId);
      if(!parent)throw new InputError('Item not found.',404);
      if(parent.deleted_at||parent.archived_at)throw new InputError('Restore this item before posting an update.');
      const child=parent.checklist.find(c=>c.id===childId);
      if(!child)throw new InputError('Subitem not found.',404);
      if(child.archived_at)throw new InputError('Restore this subitem before posting an update.');
      const id='daybook:'+randomUUID(),itemSourceId=child.source_id||`${/^\d+$/.test(child.id)?'monday':'daybook'}:${child.id}`,createdAt=new Date().toISOString();
      run('INSERT INTO item_updates(id,item_source_id,creator,created_at,text_body,assets) VALUES(?,?,?,?,?,?)',id,itemSourceId,author,createdAt,textBody,JSON.stringify(assets));
      return {id,item_source_id:itemSourceId,creator:author,created_at:createdAt,text_body:textBody,assets,replies:[]};
    });
  }
  function addList(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Invalid list.');
    const name = string(input.name, 80, 'List name', true);
    const color = input.color || '#548775';
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new InputError('Invalid list color.');
    if (get('SELECT id FROM lists WHERE lower(name)=lower(?)', name)) throw new InputError('A list with that name already exists.');
    const id = randomUUID();
    run('INSERT INTO lists(id,name,color,position,source_id) VALUES(?,?,?,?,?)', id, name, color, get('SELECT count(*) AS n FROM lists').n, input.source_id || null);
    return get('SELECT * FROM lists WHERE id=?', id);
  }
  function updateList(id, input) {
    return transaction(() => {
      const old=get('SELECT * FROM lists WHERE id=?',id);
      if(!old)throw new InputError('Board not found.',404);
      if(input.version!==old.version)throw new InputError('This board changed in another tab. Refresh and try again.',409);
      const name=input.name===undefined?old.name:string(input.name,80,'Board name',true);
      if(get('SELECT id FROM lists WHERE lower(name)=lower(?) AND id<>?',name,id))throw new InputError('A board with that name already exists.');
      let columnLabels=old.column_labels,statusSettings=old.status_settings,subitemStatusSettings=old.subitem_status_settings;
      if(input.column_labels!==undefined){
        if(!input.column_labels||typeof input.column_labels!=='object'||Array.isArray(input.column_labels))throw new InputError('Invalid column names.');
        const valid=['item','subitem','person','status','date','priority','board','quantity','repeat'];
        if(Object.keys(input.column_labels).some(key=>!valid.includes(key)))throw new InputError('Invalid column name.');
        columnLabels=JSON.stringify(Object.fromEntries(Object.entries(input.column_labels).map(([key,value])=>[key,string(value,40,'Column name',true)])));
      }
      if(input.status_settings!==undefined){
        const settings=input.status_settings;
        if(!settings||typeof settings!=='object'||Array.isArray(settings)||Object.keys(settings).length>20)throw new InputError('Invalid status labels.');
        const normalized={};
        for(const [key,value] of Object.entries(settings)){
          if(!/^(todo|doing|waiting|done|custom_[a-z0-9]{4,32})$/.test(key)||!value||typeof value!=='object')throw new InputError('Invalid status label.');
          const label=string(value.label,40,'Status label',true),color=string(value.color,7,'Status color',true);
          if(!/^#[0-9a-f]{6}$/i.test(color))throw new InputError('Invalid status color.');
          normalized[key]={label,color};
        }
        for(const key of Object.keys(JSON.parse(old.status_settings)))if(key.startsWith('custom_')&&!Object.hasOwn(normalized,key)){
          if(get('SELECT id FROM tasks WHERE list_id=? AND status=? LIMIT 1',id,key)||all('SELECT checklist FROM tasks WHERE list_id=?',id).some(row=>JSON.parse(row.checklist).some(child=>child.status===key)))throw new InputError('Move items out of this status before deleting its label.');
          if(get("SELECT id FROM automation_rules WHERE list_id=? AND trigger_type='status_changed' AND trigger_value=? LIMIT 1",id,key))throw new InputError('Remove automations using this status before deleting its label.');
        }
        statusSettings=JSON.stringify(normalized);
      }
      if(input.subitem_status_settings!==undefined){
        const settings=input.subitem_status_settings;
        if(!settings||typeof settings!=='object'||Array.isArray(settings)||Object.keys(settings).length>30)throw new InputError('Invalid subitem status labels.');
        const normalized={};
        for(const [key,value] of Object.entries(settings)){
          if(!/^(todo|doing|waiting|done|custom_[a-z0-9]{4,32})$/.test(key)||!value||typeof value!=='object')throw new InputError('Invalid subitem status label.');
          const label=string(value.label,40,'Subitem status label',true),color=string(value.color,7,'Subitem status color',true);
          if(!/^#[0-9a-f]{6}$/i.test(color))throw new InputError('Invalid subitem status color.');
          normalized[key]={label,color,done:value.done===true};
        }
        for(const key of Object.keys(JSON.parse(old.subitem_status_settings)))if(key.startsWith('custom_')&&!Object.hasOwn(normalized,key)&&all('SELECT checklist FROM tasks WHERE list_id=?',id).some(row=>JSON.parse(row.checklist).some(child=>child.status===key)))throw new InputError('Move subitems out of this status before deleting its label.');
        subitemStatusSettings=JSON.stringify(normalized);
      }
      const deletedAt=input.deleted===true?new Date().toISOString():input.deleted===false?null:old.deleted_at;
      run('UPDATE lists SET name=?,column_labels=?,status_settings=?,subitem_status_settings=?,deleted_at=?,version=version+1 WHERE id=?',name,columnLabels,statusSettings,subitemStatusSettings,deletedAt,id);
      return get('SELECT * FROM lists WHERE id=?',id);
    });
  }
  function importData(data) {
    if (!data || !Array.isArray(data.tasks) || data.tasks.length > 20000) throw new InputError('Choose a valid export with at most 20,000 tasks.');
    if (data.lists !== undefined && (!Array.isArray(data.lists) || data.lists.length > 200)) throw new InputError('An import can contain up to 200 lists.');
    if (data.groups !== undefined && (!Array.isArray(data.groups) || data.groups.length > 2000)) throw new InputError('An import can contain up to 2,000 groups.');
    if (data.updates !== undefined && (!Array.isArray(data.updates) || data.updates.length > 20000)) throw new InputError('An import can contain up to 20,000 updates.');
    if (data.automations !== undefined && (!Array.isArray(data.automations) || data.automations.length > 2000)) throw new InputError('An import can contain up to 2,000 automations.');
    return transaction(() => {
      const mapping = new Map();
      for (const l of data.lists || []) {
        if (!l || typeof l !== 'object') throw new InputError('Invalid list.');
        const name = string(l.name, 80, 'List name', true);
        const found = l.source_id ? get('SELECT id FROM lists WHERE source_id=?', l.source_id) || addList({ ...l, name: get('SELECT id FROM lists WHERE lower(name)=lower(?)', name) ? `${name.slice(0, 65)} (${String(l.source_id).slice(-8)})` : name }) : get('SELECT id FROM lists WHERE lower(name)=lower(?)', name) || addList(l);
        mapping.set(l.id, found.id);
        if(data.format==='daybook-v1'&&(l.column_labels||l.status_settings||l.subitem_status_settings)){
          const labels=typeof l.column_labels==='string'?JSON.parse(l.column_labels):l.column_labels||{};
          const statuses=typeof l.status_settings==='string'?JSON.parse(l.status_settings):l.status_settings||{};
          const subStatuses=typeof l.subitem_status_settings==='string'?JSON.parse(l.subitem_status_settings):l.subitem_status_settings||{};
          run('UPDATE lists SET column_labels=?,status_settings=?,subitem_status_settings=? WHERE id=?',JSON.stringify(labels),JSON.stringify(statuses),JSON.stringify(subStatuses),found.id);
        }
      }
      for (const group of data.groups || []) {
        if (!group || typeof group !== 'object') throw new InputError('Invalid group.');
        const listId = mapping.get(group.list_id) || group.list_id;
        const name = string(group.name, 100, 'Group name', true);
        if (typeof listId !== 'string' || !get('SELECT id FROM lists WHERE id=?', listId)) throw new InputError('Choose an existing board.');
        const found=get('SELECT id FROM board_groups WHERE list_id=? AND name=?',listId,name)||addGroup({...group,name,list_id:listId});
        if(group.id)mapping.set(`group:${group.id}`,found.id);
      }
      let imported = 0, skipped = 0;
      for (const input of data.tasks) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Invalid task.');
        const sourceId = input.source_id || (data.format === 'daybook-v1' && input.id ? `daybook:${input.id}` : null);
        if (sourceId) {
          const found=get('SELECT id FROM tasks WHERE source_id=? OR id=?', sourceId, input.id || '');
          if(found){if(typeof input.id==='string')mapping.set(`task:${input.id}`,found.id);skipped++;continue;}
        }
        const listId = mapping.get(input.list_id) || input.list_id;
        const task = insert({ ...input, list_id: listId, source_id: sourceId });
        if (data.format === 'daybook-v1') {
          const timestamp = v => typeof v === 'string' && !isNaN(Date.parse(v)) ? new Date(v).toISOString() : null;
          const position=Number.isSafeInteger(input.order_position)?input.order_position:task.order_position;
          run('UPDATE tasks SET created_at=?,updated_at=?,completed_at=?,deleted_at=?,archived_at=?,completed_on=?,order_position=? WHERE id=?', timestamp(input.created_at) || task.created_at, timestamp(input.updated_at) || task.updated_at, task.status === 'done' ? timestamp(input.completed_at) || task.completed_at : null, timestamp(input.deleted_at), timestamp(input.archived_at), validDate(input.completed_on||''), position, task.id);
        }
        if (typeof input.id === 'string') mapping.set(`task:${input.id}`, task.id);
        imported++;
      }
      for (const input of data.tasks) {
        if (typeof input.id !== 'string') continue;
        const id = mapping.get(`task:${input.id}`);
        if(!id)continue;
        const next = typeof input.next_task_id==='string'?mapping.get(`task:${input.next_task_id}`):null;
        if(next)run('UPDATE tasks SET next_task_id=? WHERE id=?', next, id);
        const converted=typeof input.converted_into==='string'?mapping.get(`task:${input.converted_into}`):null;
        if(converted)run('UPDATE tasks SET converted_into=? WHERE id=?',converted,id);
      }
      let updatesImported=0,updatesSkipped=0;
      for(const u of data.updates||[]){
        if(!u||typeof u!=='object'||Array.isArray(u))throw new InputError('Invalid update.');
        const id=string(u.id,80,'Update ID',true);
        const itemSourceId=string(u.item_source_id,100,'Item source ID',true);
        const creator=string(u.creator||'Unknown',100,'Update author');
        const createdAt=string(u.created_at,40,'Update date',true);
        if(!Number.isFinite(Date.parse(createdAt)))throw new InputError('Invalid update date.');
        const textBody=string(u.text_body||'',50000,'Update text');
        const assets=JSON.stringify(u.assets||[]),replies=JSON.stringify(u.replies||[]);
        if(assets.length>100000||replies.length>100000)throw new InputError('Update attachments are too large.');
        const result=run('INSERT INTO item_updates(id,item_source_id,creator,created_at,text_body,assets,replies) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',id,itemSourceId,creator,createdAt,textBody,assets,replies);
        if(result.changes)updatesImported++;else updatesSkipped++;
      }
      for(const input of data.automations||[]){
        const listId=mapping.get(input.list_id)||input.list_id;
        if(!get('SELECT id FROM lists WHERE id=?',listId))throw new InputError('Choose an existing automation board.');
        const sourceId=input.source_id||(data.format==='daybook-v1'&&input.id?`daybook:${input.id}`:null);
        const found=sourceId&&get('SELECT id FROM automation_rules WHERE source_id=?',sourceId)||input.id&&get('SELECT id FROM automation_rules WHERE id=?',input.id);
        if(found){if(input.id)mapping.set(`automation:${input.id}`,found.id);continue;}
        let actionValue=input.action_type==='move_group'?mapping.get(`group:${input.action_value}`)||input.action_value:input.action_value;
        if(input.action_type==='create_item'){const config=JSON.parse(input.action_value);actionValue=JSON.stringify({...config,group_id:mapping.get(`group:${config.group_id}`)||config.group_id||''});}
        const rule=validateAutomation({...input,list_id:listId,action_value:actionValue,enabled:!!input.enabled});
        const ruleId=randomUUID();
        run('INSERT INTO automation_rules(id,list_id,name,trigger_type,trigger_value,action_type,action_value,enabled,source_id) VALUES(?,?,?,?,?,?,?,?,?)',ruleId,listId,rule.name,rule.trigger_type,rule.trigger_value,rule.action_type,rule.action_value,rule.enabled?1:0,sourceId);
        if(input.id)mapping.set(`automation:${input.id}`,ruleId);
      }
      for(const event of data.automation_events||[]){
        if(!event||typeof event!=='object'||Array.isArray(event))throw new InputError('Invalid automation event.');
        const ruleId=mapping.get(`automation:${event.rule_id}`);
        if(!ruleId)continue;
        const key=string(event.event_key,200,'Automation event key',true);
        const description=string(event.description,600,'Automation event description',true);
        const createdAt=string(event.created_at,40,'Automation event date',true);
        if(!Number.isFinite(Date.parse(createdAt)))throw new InputError('Invalid automation event date.');
        run('INSERT INTO automation_events(id,rule_id,task_id,event_key,description,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(rule_id,event_key) DO NOTHING',randomUUID(),ruleId,mapping.get(`task:${event.task_id}`)||null,key,description,createdAt);
      }
      return data.updates ? { imported, skipped, updatesImported, updatesSkipped } : { imported, skipped };
    });
  }
  function addGroup(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InputError('Invalid group.');
    const name = string(input.name, 100, 'Group name', true), color = input.color || '#579bfc';
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new InputError('Invalid group color.');
    if (typeof input.list_id !== 'string' || !get('SELECT id FROM lists WHERE id=?', input.list_id)) throw new InputError('Choose an existing board.');
    if (get('SELECT id FROM board_groups WHERE list_id=? AND name=?', input.list_id, name)) throw new InputError('A group with that name already exists on this board.');
    const id = randomUUID();
    run('INSERT INTO board_groups(id,list_id,name,color,position) VALUES(?,?,?,?,?)', id, input.list_id, name, color, get('SELECT count(*) AS n FROM board_groups WHERE list_id=?', input.list_id).n);
    return get('SELECT * FROM board_groups WHERE id=?', id);
  }
  function updateGroup(id,input) {
    return transaction(() => {
      const old=get('SELECT * FROM board_groups WHERE id=?',id);
      if(!old)throw new InputError('Group not found.',404);
      if(input.version!==old.version)throw new InputError('This group changed in another tab. Refresh and try again.',409);
      const name=input.name===undefined?old.name:string(input.name,100,'Group name',true);
      const color=input.color===undefined?old.color:string(input.color,7,'Group color',true);
      if(!/^#[0-9a-f]{6}$/i.test(color))throw new InputError('Invalid group color.');
      if(get('SELECT id FROM board_groups WHERE list_id=? AND name=? AND id<>?',old.list_id,name,id))throw new InputError('A group with that name already exists on this board.');
      let position=old.position;
      if(input.position!==undefined){
        const ordered=all('SELECT id,position FROM board_groups WHERE list_id=? ORDER BY position,name',old.list_id);
        if(!Number.isInteger(input.position)||input.position<0||input.position>=ordered.length)throw new InputError('Invalid group position.');
        const oldIndex=ordered.findIndex(group=>group.id===id);
        if(input.position!==oldIndex){
          const [moving]=ordered.splice(oldIndex,1);ordered.splice(input.position,0,moving);
          for(const [index,group] of ordered.entries())if(group.id!==id&&group.position!==index)run('UPDATE board_groups SET position=?,version=version+1 WHERE id=?',index,group.id);
          position=input.position;
        }
      }
      run('UPDATE board_groups SET name=?,color=?,position=?,version=version+1 WHERE id=?',name,color,position,id);
      if(name!==old.name)run('UPDATE tasks SET category=?,version=version+1 WHERE list_id=? AND category=?',name,old.list_id,old.name);
      return get('SELECT * FROM board_groups WHERE id=?',id);
    });
  }
  function validateAutomation(input,existing={}){
    if(!input||typeof input!=='object'||Array.isArray(input))throw new InputError('Invalid automation.');
    const rule={name:'',trigger_type:'status_changed',trigger_value:'',action_type:'move_group',action_value:'',enabled:true,...existing,...input};
    rule.name=string(rule.name,120,'Automation name',true);
    rule.trigger_type=choice(rule.trigger_type,['status_changed','due_date_arrives','monthly'],'automation trigger');
    rule.action_type=choice(rule.action_type,['move_group','set_completed_on','notify','create_item','add_update'],'automation action');
    rule.trigger_value=string(rule.trigger_value,80,'Trigger value');
    rule.action_value=string(rule.action_value,500,'Action value');
    if(typeof rule.enabled!=='boolean')throw new InputError('Invalid automation state.');
    if(rule.trigger_type==='status_changed'){
      const settings=JSON.parse(get('SELECT status_settings FROM lists WHERE id=?',rule.list_id)?.status_settings||'{}');
      if(!STATUSES.includes(rule.trigger_value)&&!Object.hasOwn(settings,rule.trigger_value))throw new InputError('Choose a status on this board.');
      if(!['move_group','set_completed_on','add_update'].includes(rule.action_type))throw new InputError('Choose a status action.');
    }else if(rule.trigger_type==='due_date_arrives'){
      if(rule.action_type!=='notify')throw new InputError('Due date rules must create a reminder.');
      rule.trigger_value='';
    }else{
      if(!/^(?:[1-9]|[12][0-9]|3[01])$/.test(rule.trigger_value)||rule.action_type!=='create_item')throw new InputError('Choose a day of month for item creation.');
    }
    if(rule.action_type==='move_group'||rule.action_type==='create_item'){
      if(rule.action_type==='move_group'&&!get('SELECT id FROM board_groups WHERE id=? AND list_id=?',rule.action_value,rule.list_id))throw new InputError('Choose a group on this board.');
      if(rule.action_type==='create_item'){
        let config;try{config=JSON.parse(rule.action_value);}catch{throw new InputError('Invalid new item settings.');}
        if(!config||typeof config!=='object')throw new InputError('Invalid new item settings.');
        config.title=string(config.title,500,'New item title',true);
        if(config.group_id&&!get('SELECT id FROM board_groups WHERE id=? AND list_id=?',config.group_id,rule.list_id))throw new InputError('Choose a group on this board.');
        rule.action_value=JSON.stringify({title:config.title,group_id:config.group_id||''});
      }
    }
    if(rule.action_type==='add_update')rule.action_value=string(rule.action_value,500,'Update text',true);
    if(rule.action_type==='notify')rule.action_value=string(rule.action_value,500,'Reminder text',true);
    if(rule.action_type==='set_completed_on')rule.action_value='';
    return rule;
  }
  function addAutomation(input){
    if(typeof input?.list_id!=='string'||!get('SELECT id FROM lists WHERE id=? AND deleted_at IS NULL',input.list_id))throw new InputError('Choose an active board.');
    if(get('SELECT count(*) AS n FROM automation_rules WHERE list_id=?',input.list_id).n>=50)throw new InputError('A board can have up to 50 automations.');
    const rule=validateAutomation(input);const id=randomUUID();
    run('INSERT INTO automation_rules(id,list_id,name,trigger_type,trigger_value,action_type,action_value,enabled) VALUES(?,?,?,?,?,?,?,?)',id,rule.list_id,rule.name,rule.trigger_type,rule.trigger_value,rule.action_type,rule.action_value,rule.enabled?1:0);
    return get('SELECT * FROM automation_rules WHERE id=?',id);
  }
  function updateAutomation(id,input){
    return transaction(()=>{
      const old=get('SELECT * FROM automation_rules WHERE id=?',id);
      if(!old)throw new InputError('Automation not found.',404);
      if(input.version!==old.version)throw new InputError('This automation changed in another tab. Refresh and try again.',409);
      const rule=validateAutomation({...input,list_id:old.list_id},{...old,enabled:!!old.enabled});
      run('UPDATE automation_rules SET name=?,trigger_type=?,trigger_value=?,action_type=?,action_value=?,enabled=?,version=version+1 WHERE id=?',rule.name,rule.trigger_type,rule.trigger_value,rule.action_type,rule.action_value,rule.enabled?1:0,id);
      return get('SELECT * FROM automation_rules WHERE id=?',id);
    });
  }
  function recordAutomation(rule,taskId,eventKey,description){
    return run('INSERT INTO automation_events(id,rule_id,task_id,event_key,description,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(rule_id,event_key) DO NOTHING',randomUUID(),rule.id,taskId,eventKey,description,new Date().toISOString()).changes;
  }
  function runStatusAutomations(taskId,previous,current,now){
    const task=findTask(taskId);
    for(const rule of all("SELECT * FROM automation_rules WHERE list_id=? AND enabled=1 AND trigger_type='status_changed' AND trigger_value=? ORDER BY rowid",task.list_id,current)){
      const key=`${taskId}:${current}:${task.version}`;
      if(rule.action_type==='move_group'){
        const group=get('SELECT name FROM board_groups WHERE id=? AND list_id=?',rule.action_value,task.list_id);
        if(!group||group.name===findTask(taskId).category)continue;
        run('UPDATE tasks SET category=?,order_position=?,updated_at=?,version=version+1 WHERE id=?',group.name,firstPosition(task.list_id,group.name),now,taskId);
        recordAutomation(rule,taskId,key,`Moved ${task.title} to ${group.name}`);
      }else if(rule.action_type==='set_completed_on'){
        const date=today(timeZone);
        run('UPDATE tasks SET completed_on=?,updated_at=?,version=version+1 WHERE id=?',date,now,taskId);
        recordAutomation(rule,taskId,key,`Set Completed On for ${task.title} to ${date}`);
      }else if(rule.action_type==='add_update'){
        run('INSERT INTO item_updates(id,item_source_id,creator,created_at,text_body) VALUES(?,?,?,?,?)','daybook:'+randomUUID(),task.source_id||'daybook:'+task.id,'Automation',now,rule.action_value);
        recordAutomation(rule,taskId,key,`Posted an update on ${task.title}`);
      }
    }
  }
  function runScheduledAutomations(currentDay=today(timeZone)){
    validDate(currentDay);
    return transaction(()=>{
      let count=0;
      for(const rule of all("SELECT * FROM automation_rules WHERE enabled=1 AND trigger_type IN ('due_date_arrives','monthly') ORDER BY rowid")){
        if(rule.trigger_type==='due_date_arrives'){
          for(const task of all("SELECT id,title,version FROM tasks WHERE list_id=? AND due_date=? AND status<>'done' AND deleted_at IS NULL AND archived_at IS NULL",rule.list_id,currentDay)){
            count+=recordAutomation(rule,task.id,`${task.id}:${currentDay}`,`${rule.action_value}: ${task.title}`);
          }
        }else if(Number(rule.trigger_value)===Number(currentDay.slice(8))){
          const eventKey=currentDay.slice(0,7);
          if(get('SELECT id FROM automation_events WHERE rule_id=? AND event_key=?',rule.id,eventKey))continue;
          const config=JSON.parse(rule.action_value),group=config.group_id?get('SELECT name FROM board_groups WHERE id=? AND list_id=?',config.group_id,rule.list_id):null;
          const task=insert({title:config.title,list_id:rule.list_id,category:group?.name||''});
          count+=recordAutomation(rule,task.id,eventKey,`Created ${task.title}${group?' in '+group.name:''}`);
        }
      }
      return count;
    });
  }
  function setOrder(source,target,after){
    const rows=all('SELECT id,order_position FROM tasks WHERE list_id=? AND category=? ORDER BY order_position,created_at DESC,id',source.list_id,source.category);
    const original=rows.map(row=>row.id),next=original.filter(id=>id!==source.id);
    const oldPositions=new Map(rows.map(row=>[row.id,row.order_position]));
    next.splice(next.indexOf(target.id)+(after?1:0),0,source.id);
    if(next.every((id,index)=>id===original[index]))return false;
    next.forEach((id,index)=>{if(oldPositions.get(id)!==index)run('UPDATE tasks SET order_position=? WHERE id=?',index,id);});
    run('UPDATE tasks SET version=version+1 WHERE id=?',source.id);
    return true;
  }
  function reorderTask(id,input){
    return transaction(()=>{
      const source=findTask(id),target=input?.target_id?findTask(input.target_id):null;
      if(!source||(input?.target_id&&!target))throw new InputError('Item not found.',404);
      if(input.version!==source.version)throw new InputError('This item changed in another tab. Refresh and try again.',409);
      if(typeof input.after!=='boolean'||source.deleted_at||source.archived_at||target&&(source.id===target.id||source.list_id!==target.list_id||target.deleted_at||target.archived_at))throw new InputError('Choose another active item on this board.');
      const category=target?target.category:string(input.category,100,'Group');
      if(!target&&category&&!get('SELECT id FROM board_groups WHERE list_id=? AND name=?',source.list_id,category)&&!get('SELECT id FROM tasks WHERE list_id=? AND category=? LIMIT 1',source.list_id,category))throw new InputError('Choose a group on this board.');
      const rows=all('SELECT id,order_position FROM tasks WHERE list_id=? AND category=? ORDER BY order_position,created_at DESC,id',source.list_id,category);
      const original=rows.map(row=>row.id),positions=new Map(rows.map(row=>[row.id,row.order_position])),next=original.filter(itemId=>itemId!==id);
      const position=target?next.indexOf(target.id)+(input.after?1:0):input.after?next.length:0;
      next.splice(position,0,id);
      if(category===source.category&&next.every((itemId,index)=>itemId===original[index]))return source;
      run('UPDATE tasks SET category=?,updated_at=?,version=version+1 WHERE id=?',category,new Date().toISOString(),id);
      next.forEach((itemId,index)=>{if(itemId===id||positions.get(itemId)!==index)run('UPDATE tasks SET order_position=? WHERE id=?',index,itemId);});
      return findTask(id);
    });
  }
  function createBelow(id) {
    return transaction(() => {
      const target=findTask(id);
      if(!target||target.deleted_at||target.archived_at)throw new InputError('Item not found.',404);
      const task=insert({title:'New item',list_id:target.list_id,category:target.category,status:target.status});
      const timestamp=new Date(Date.parse(target.created_at)-1).toISOString();
      run('UPDATE tasks SET created_at=? WHERE id=?',timestamp,task.id);
      setOrder(task,target,true);
      return findTask(task.id);
    });
  }
  function convertToSubitem(id,parentId) {
    return transaction(() => {
      const item=findTask(id),parent=findTask(parentId);
      if(!item||!parent||item.id===parent.id||item.list_id!==parent.list_id||item.deleted_at||item.archived_at||parent.deleted_at||parent.archived_at)throw new InputError('Choose another active item on this board.');
      if(parent.checklist.length>=1000)throw new InputError('This item has too many subitems.');
      const child={id:randomUUID(),title:item.title,done:item.status==='done',status:item.status,assignee:item.assignee,due_date:item.due_date,notes:item.notes,priority:item.priority,source_id:item.source_id||'',external_data:item.external_data};
      const validated=validateTask({...parent,checklist:[...parent.checklist,child]});
      const now=new Date().toISOString();
      run('UPDATE tasks SET checklist=?,updated_at=?,version=version+1 WHERE id=?',JSON.stringify(validated.checklist),now,parent.id);
      run('UPDATE tasks SET deleted_at=?,converted_into=?,updated_at=?,version=version+1 WHERE id=?',now,parent.id,now,item.id);
      return {parent:findTask(parent.id),item:findTask(item.id)};
    });
  }
  function convertSubitemToItem(parentId,childId) {
    return transaction(() => {
      const parent=findTask(parentId);
      if(!parent||parent.deleted_at||parent.archived_at)throw new InputError('Item not found.',404);
      const child=parent.checklist.find(c=>c.id===childId);
      if(!child)throw new InputError('Subitem not found.',404);
      const source=child.source_id&&!get('SELECT id FROM tasks WHERE source_id=?',child.source_id)?child.source_id:null;
      const validTopStatuses=JSON.parse(get('SELECT status_settings FROM lists WHERE id=?',parent.list_id).status_settings||'{}');
      const desired=child.status||(child.done?'done':'todo');
      const task=insert({title:child.title,list_id:parent.list_id,category:parent.category,status:STATUSES.includes(desired)||Object.hasOwn(validTopStatuses,desired)?desired:child.done?'done':'todo',assignee:child.assignee||'',due_date:child.due_date||'',priority:child.priority||'none',notes:child.notes||'',external_data:child.external_data||'{}',source_id:source});
      run('UPDATE tasks SET checklist=?,updated_at=?,version=version+1 WHERE id=?',JSON.stringify(parent.checklist.filter(c=>c.id!==childId)),new Date().toISOString(),parent.id);
      return task;
    });
  }
  function moveSubitem(parentId,childId,targetId) {
    return transaction(() => {
      const parent=findTask(parentId),target=findTask(targetId);
      if(!parent||!target||parent.id===target.id||parent.list_id!==target.list_id||parent.deleted_at||target.deleted_at||parent.archived_at||target.archived_at)throw new InputError('Choose another active item on this board.');
      const child=parent.checklist.find(c=>c.id===childId);
      if(!child)throw new InputError('Subitem not found.',404);
      if(target.checklist.length>=1000)throw new InputError('This item has too many subitems.');
      const now=new Date().toISOString();
      run('UPDATE tasks SET checklist=?,updated_at=?,version=version+1 WHERE id=?',JSON.stringify(parent.checklist.filter(c=>c.id!==childId)),now,parent.id);
      run('UPDATE tasks SET checklist=?,updated_at=?,version=version+1 WHERE id=?',JSON.stringify([...target.checklist,child]),now,target.id);
      return {from:findTask(parent.id),to:findTask(target.id)};
    });
  }
  const snapshot = () => ({ format: 'daybook-v1', exported_at: new Date().toISOString(), timeZone, today: today(timeZone), lists: all('SELECT * FROM lists ORDER BY position,name'), groups: all('SELECT * FROM board_groups ORDER BY position,name'), tasks: all('SELECT * FROM tasks ORDER BY created_at DESC,id').map(decode), updates: all('SELECT * FROM item_updates ORDER BY created_at DESC,id').map(u=>({...u,assets:JSON.parse(u.assets),replies:JSON.parse(u.replies)})), automations: all('SELECT * FROM automation_rules ORDER BY list_id,rowid'), automation_events: all('SELECT * FROM automation_events ORDER BY created_at DESC LIMIT 500') });
  return { db, run, get, all, transaction, snapshot, findTask, insert, update, reorderTask, addUpdate, addSubitemUpdate, addList, updateList, addGroup, updateGroup, addAutomation, updateAutomation, runScheduledAutomations, createBelow, convertToSubitem, convertSubitemToItem, moveSubitem, importData };
}
