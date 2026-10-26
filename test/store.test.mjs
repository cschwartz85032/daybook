import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, nextDate, today } from '../lib/store.mjs';

test('board upgrade preserves existing items and adds persistent groups and people', () => {
  const dir = mkdtempSync(join(tmpdir(),'daybook-upgrade-')), path = join(dir,'v1.sqlite');
  let s = openStore(path);
  try {
    const list_id=s.snapshot().lists[0].id;
    const original=s.insert({title:'Existing item',list_id,category:'This week',notes:'Keep this note',checklist:[{title:'Existing subitem',done:true}]});
    // Recreate the schema shipped before the board interface, then open it again.
    s.db.exec('DROP INDEX tasks_order; ALTER TABLE tasks DROP COLUMN order_position; ALTER TABLE tasks DROP COLUMN assignee; DROP TABLE board_groups; PRAGMA user_version=1');
    s.db.close();s=openStore(path);
    assert.equal(s.findTask(original.id).notes,'Keep this note');
    assert.equal(s.findTask(original.id).checklist[0].done,true);
    assert.equal(s.findTask(original.id).assignee,'');
    const group=s.addGroup({list_id,name:'Next week',color:'#a25ddc'});
    const edited=s.update(original.id,{version:original.version,assignee:'owner',category:group.name});
    s.db.close();s=openStore(path);
    assert.equal(s.snapshot().groups[0].name,'Next week');
    assert.equal(s.findTask(original.id).assignee,'owner');
    assert.equal(s.findTask(original.id).category,'Next week');
    assert.equal(s.findTask(original.id).version,edited.version);
    assert.equal(s.get('PRAGMA user_version').user_version,10);
  } finally {s.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('schema 3 upgrade keeps imported items while adding editable board settings', () => {
  const dir=mkdtempSync(join(tmpdir(),'daybook-schema3-')),path=join(dir,'workspace.sqlite');
  let s=openStore(path);
  try {
    const list_id=s.snapshot().lists[0].id;
    const task=s.insert({title:'Imported item',list_id,source_id:'monday:example',checklist:[{id:'subitem',title:'Nested',done:false}]});
    s.db.exec('ALTER TABLE tasks DROP COLUMN archived_at; ALTER TABLE tasks DROP COLUMN converted_into; ALTER TABLE lists DROP COLUMN column_labels; ALTER TABLE lists DROP COLUMN status_settings; ALTER TABLE lists DROP COLUMN subitem_status_settings; ALTER TABLE lists DROP COLUMN deleted_at; ALTER TABLE lists DROP COLUMN version; ALTER TABLE board_groups DROP COLUMN version; PRAGMA user_version=3');
    s.db.close();s=openStore(path);
    assert.equal(s.get('PRAGMA user_version').user_version,10);
    assert.equal(s.findTask(task.id).source_id,'monday:example');
    assert.equal(s.findTask(task.id).checklist[0].title,'Nested');
    assert.equal(s.get('SELECT column_labels FROM lists WHERE id=?',list_id).column_labels,'{}');
  } finally {s.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('boards move to trash and restore without changing their items',()=>{
  const store=openStore(':memory:');
  try{
    const board=store.snapshot().lists[0],item=store.insert({title:'Keep this item',list_id:board.id,checklist:[{title:'Keep this subitem',done:false}]});
    const deleted=store.updateList(board.id,{version:board.version,deleted:true});
    assert.ok(deleted.deleted_at);
    assert.equal(store.findTask(item.id).checklist[0].title,'Keep this subitem');
    const restored=store.updateList(board.id,{version:deleted.version,deleted:false});
    assert.equal(restored.deleted_at,null);
    assert.equal(store.snapshot().tasks.find(t=>t.id===item.id).title,'Keep this item');
  }finally{store.db.close();}
});

test('group reordering persists within its board',()=>{
  const store=openStore(':memory:');
  try{
    const board=store.addList({name:'Group order'}),otherBoard=store.addList({name:'Other group order'});
    const first=store.addGroup({list_id:board.id,name:'First'}),second=store.addGroup({list_id:board.id,name:'Second'}),third=store.addGroup({list_id:board.id,name:'Third'});
    const other=store.addGroup({list_id:otherBoard.id,name:'Separate'});
    const moved=store.updateGroup(third.id,{version:third.version,position:0});
    assert.equal(moved.position,0);
    assert.deepEqual(store.snapshot().groups.filter(g=>g.list_id===board.id).map(g=>g.name),['Third','First','Second']);
    assert.equal(store.get('SELECT position FROM board_groups WHERE id=?',other.id).position,0);
    assert.throws(()=>store.updateGroup(first.id,{version:first.version,name:'Stale'}),/another tab/);
    assert.throws(()=>store.updateGroup(moved.id,{version:moved.version,position:9}),/Invalid group position/);
  }finally{store.db.close();}
});

test('group order survives a database restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'daybook-group-order-')),path=join(dir,'workspace.sqlite');
  let store=openStore(path);
  try{
    const board=store.addList({name:'Persistent groups'});
    store.addGroup({list_id:board.id,name:'Alpha'});
    const beta=store.addGroup({list_id:board.id,name:'Beta'});
    store.updateGroup(beta.id,{version:beta.version,position:0});
    store.db.close();store=openStore(path);
    assert.deepEqual(store.snapshot().groups.filter(g=>g.list_id===board.id).map(g=>g.name),['Beta','Alpha']);
  }finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('item order persists within a group and rejects stale or cross-board moves',()=>{
  const dir=mkdtempSync(join(tmpdir(),'daybook-item-order-')),path=join(dir,'workspace.sqlite');
  let s=openStore(path);
  try{
    const list_id=s.snapshot().lists[0].id;
    const a=s.insert({title:'A',list_id,category:'Today'}),b=s.insert({title:'B',list_id,category:'Today'}),c=s.insert({title:'C',list_id,category:'Today'});
    const titles=()=>s.snapshot().tasks.filter(t=>t.list_id===list_id&&t.category==='Today').sort((x,y)=>x.order_position-y.order_position).map(t=>t.title);
    assert.deepEqual(titles(),['C','B','A']);
    s.reorderTask(a.id,{version:a.version,target_id:c.id,after:false});
    assert.deepEqual(titles(),['A','C','B']);
    assert.throws(()=>s.reorderTask(a.id,{version:a.version,target_id:b.id,after:true}),{status:409});
    const other=s.insert({title:'Other',list_id,category:'Later'});
    const anotherBoard=s.addList({name:'Another board'});
    const external=s.insert({title:'External',list_id:anotherBoard.id});
    assert.throws(()=>s.reorderTask(b.id,{version:b.version,target_id:external.id,after:true}),{status:400});
    const below=s.createBelow(c.id);
    assert.deepEqual(titles(),['A','C','New item','B']);
    assert.equal(below.category,'Today');
    s.db.close();s=openStore(path);
    assert.deepEqual(titles(),['A','C','New item','B']);
    const moved=s.update(b.id,{version:s.findTask(b.id).version,category:'Later'});
    assert.equal(moved.order_position<s.findTask(other.id).order_position,true);
  }finally{s.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('drag moves items between groups, including empty groups, and persists their order',()=>{
  const dir=mkdtempSync(join(tmpdir(),'daybook-cross-group-order-')),path=join(dir,'workspace.sqlite');
  let s=openStore(path);
  try{
    const list_id=s.snapshot().lists[0].id;
    s.addGroup({list_id,name:'Today'});s.addGroup({list_id,name:'Later'});s.addGroup({list_id,name:'Empty'});
    const a=s.insert({title:'A',list_id,category:'Today'}),b=s.insert({title:'B',list_id,category:'Today'});
    const c=s.insert({title:'C',list_id,category:'Later'}),d=s.insert({title:'D',list_id,category:'Later'});
    const titles=category=>s.snapshot().tasks.filter(t=>t.list_id===list_id&&t.category===category).sort((x,y)=>x.order_position-y.order_position).map(t=>t.title);
    const moved=s.reorderTask(a.id,{version:a.version,target_id:c.id,after:true});
    assert.equal(moved.category,'Later');
    assert.deepEqual(titles('Later'),['D','C','A']);
    assert.deepEqual(titles('Today'),['B']);
    assert.throws(()=>s.reorderTask(a.id,{version:a.version,category:'Empty',after:false}),{status:409});
    const empty=s.reorderTask(b.id,{version:b.version,category:'Empty',after:false});
    assert.equal(empty.category,'Empty');
    assert.deepEqual(titles('Empty'),['B']);
    s.reorderTask(d.id,{version:d.version,category:'Empty',after:true});
    assert.deepEqual(titles('Empty'),['B','D']);
    assert.throws(()=>s.reorderTask(empty.id,{version:empty.version,category:'Unknown',after:false}),{status:400});
    s.db.close();s=openStore(path);
    assert.deepEqual(titles('Today'),[]);
    assert.deepEqual(titles('Later'),['C','A']);
    assert.deepEqual(titles('Empty'),['B','D']);
  }finally{s.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('added board columns and item values survive restart and export',()=>{
  const dir=mkdtempSync(join(tmpdir(),'daybook-custom-columns-')),path=join(dir,'workspace.sqlite');
  let s=openStore(path);
  try{
    const board=s.snapshot().lists[0],id='col_12345678',columns=[{id,name:'Budget',type:'number'}];
    const changed=s.updateList(board.id,{version:board.version,custom_columns:columns});
    assert.deepEqual(JSON.parse(changed.custom_columns),columns);
    const item=s.insert({title:'Plan',list_id:board.id,custom_values:{[id]:'125.50'}});
    assert.equal(item.custom_values[id],'125.50');
    const edited=s.update(item.id,{version:item.version,custom_values:{[id]:'200'}});
    assert.equal(edited.custom_values[id],'200');
    assert.throws(()=>s.updateList(board.id,{version:changed.version,custom_columns:[{id,name:'Bad',type:'unknown'}]}),/column type/);
    s.db.close();s=openStore(path);
    assert.deepEqual(JSON.parse(s.snapshot().lists.find(l=>l.id===board.id).custom_columns),columns);
    assert.equal(s.snapshot().tasks.find(t=>t.id===item.id).custom_values[id],'200');
    const restored=openStore(':memory:');
    try{restored.importData(s.snapshot());assert.equal(restored.snapshot().tasks.find(t=>t.title==='Plan').custom_values[id],'200');assert.deepEqual(JSON.parse(restored.snapshot().lists.find(l=>l.name===board.name).custom_columns),columns);}finally{restored.db.close();}
  }finally{s.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('column type changes validate saved values and deletion removes them',()=>{
  const s=openStore(':memory:');
  try{
    const board=s.snapshot().lists[0],id='col_87654321';
    let list=s.updateList(board.id,{version:board.version,custom_columns:[{id,name:'Notes',type:'text'}]});
    const item=s.insert({list_id:board.id,title:'Entry',custom_values:{[id]:'not a number'}});
    assert.throws(()=>s.updateList(board.id,{version:list.version,custom_columns:[{id,name:'Notes',type:'number'}]}),/nonnumeric/);
    assert.equal(s.findTask(item.id).custom_values[id],'not a number');
    const edited=s.update(item.id,{version:item.version,custom_values:{[id]:'42'}});
    list=s.updateList(board.id,{version:list.version,custom_columns:[{id,name:'Amount',type:'number'}]});
    assert.equal(JSON.parse(list.custom_columns)[0].name,'Amount');
    assert.throws(()=>s.update(edited.id,{version:edited.version,custom_values:{[id]:'invalid'}}),/must be a number/);
    s.updateList(board.id,{version:list.version,custom_columns:[]});
    assert.equal(s.findTask(item.id).custom_values[id],undefined);
  }finally{s.db.close();}
});

test('schema 8 migration keeps the displayed order of existing group items',()=>{
  const dir=mkdtempSync(join(tmpdir(),'daybook-order-migration-')),path=join(dir,'workspace.sqlite');
  let s=openStore(path);
  try{
    const list_id=s.snapshot().lists[0].id;
    const a=s.insert({title:'Older',list_id,category:'Today'}),b=s.insert({title:'Newer',list_id,category:'Today'});
    s.run('UPDATE tasks SET created_at=? WHERE id=?','2020-01-01T00:00:00.000Z',a.id);
    s.run('UPDATE tasks SET created_at=? WHERE id=?','2021-01-01T00:00:00.000Z',b.id);
    s.db.exec('DROP INDEX tasks_order; ALTER TABLE tasks DROP COLUMN order_position; PRAGMA user_version=8');
    s.db.close();s=openStore(path);
    const rows=s.all('SELECT title,order_position FROM tasks WHERE list_id=? AND category=? ORDER BY order_position',list_id,'Today');
    assert.deepEqual(rows.map(row=>row.title),['Newer','Older']);
    assert.equal(s.get('PRAGMA user_version').user_version,10);
  }finally{s.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('moving an item to another board or group survives restart',()=>{
  const dir=mkdtempSync(join(tmpdir(),'daybook-item-move-')),path=join(dir,'workspace.sqlite');
  let store=openStore(path);
  try{
    const source=store.addList({name:'Move source'}),target=store.addList({name:'Move target'});
    store.addGroup({list_id:target.id,name:'Destination'});
    const item=store.insert({list_id:source.id,title:'Move me',checklist:[{title:'Child',status:'todo',done:false}]});
    const moved=store.update(item.id,{version:item.version,list_id:target.id,category:'Destination'});
    store.db.close();store=openStore(path);
    const persisted=store.findTask(item.id);
    assert.equal(persisted.list_id,target.id);
    assert.equal(persisted.category,'Destination');
    assert.equal(persisted.checklist[0].title,'Child');
    assert.equal(persisted.version,moved.version);
  }finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
});

test('board automations move items, stamp dates, and run scheduled rules once',()=>{
  const store=openStore(':memory:');
  try{
    const board=store.addList({name:'Automation test'}),group=store.addGroup({list_id:board.id,name:'Completed'});
    store.addAutomation({list_id:board.id,name:'Move completed',trigger_type:'status_changed',trigger_value:'done',action_type:'move_group',action_value:group.id,enabled:true});
    store.addAutomation({list_id:board.id,name:'Date completed',trigger_type:'status_changed',trigger_value:'done',action_type:'set_completed_on',action_value:'',enabled:true});
    store.addAutomation({list_id:board.id,name:'Due reminder',trigger_type:'due_date_arrives',action_type:'notify',action_value:'Due today',enabled:true});
    store.addAutomation({list_id:board.id,name:'Monthly item',trigger_type:'monthly',trigger_value:'1',action_type:'create_item',action_value:JSON.stringify({title:'Monthly review',group_id:group.id}),enabled:true});
    const task=store.insert({title:'Finish report',list_id:board.id,due_date:'2026-11-01'});
    assert.equal(store.runScheduledAutomations('2026-11-01'),2);
    assert.equal(store.runScheduledAutomations('2026-11-01'),0);
    assert.equal(store.snapshot().tasks.filter(t=>t.title==='Monthly review').length,1);
    const updated=store.update(task.id,{version:task.version,status:'done'});
    assert.equal(updated.category,'Completed');
    assert.equal(updated.completed_on,today());
    assert.equal(store.snapshot().automation_events.length,4);
    assert.throws(()=>store.updateAutomation(store.snapshot().automations[0].id,{version:0,enabled:false}),/another tab/);
  }finally{store.db.close();}
});

test('groups and assignments round-trip through export, deduplicate and roll back atomically', () => {
  const source=openStore(':memory:'),restored=openStore(':memory:');
  try {
    const list_id=source.snapshot().lists[0].id;
    const group=source.addGroup({list_id,name:'Empty group',color:'#579bfc'});
    source.addAutomation({list_id,name:'Move done',trigger_type:'status_changed',trigger_value:'done',action_type:'move_group',action_value:group.id,enabled:true});
    assert.throws(()=>source.addGroup({list_id,name:'Empty group'}),/already exists/);
    assert.throws(()=>source.addGroup({list_id:'missing',name:'Invalid'}),/existing board/);
    assert.throws(()=>source.addGroup({list_id,name:'Invalid',color:'red'}),/color/);
    const t=source.insert({title:'Recurring assigned item',list_id,assignee:'owner',repeat:'weekly'});
    const done=source.update(t.id,{version:t.version,status:'done'});
    assert.equal(source.findTask(done.next_task_id).assignee,'owner');
    const exported=source.snapshot();
    assert.equal(restored.importData(exported).imported,2);
    assert.equal(restored.snapshot().groups[0].name,'Empty group');
    assert.equal(restored.snapshot().automations[0].action_value,restored.snapshot().groups[0].id);
    assert.equal(restored.snapshot().automation_events.length,1);
    assert.equal(restored.snapshot().automation_events[0].task_id,restored.snapshot().tasks.find(task=>task.status==='done').id);
    assert.ok(restored.snapshot().tasks.every(t=>t.assignee==='owner'));
    assert.equal(restored.importData(exported).skipped,2);
    assert.equal(restored.snapshot().groups.length,1);
    assert.equal(restored.snapshot().automation_events.length,1);
    const target=restored.snapshot().lists[0].id;
    assert.throws(()=>restored.importData({groups:[{list_id:target,name:'Rolled back'}],tasks:[{list_id:target,title:''}]}));
    assert.equal(restored.snapshot().groups.length,1);
  } finally {source.db.close();restored.db.close();}
});

test('Monday boards with duplicate names and rich subitems import without losing source fields', () => {
  const store=openStore(':memory:');
  try {
    const payload={format:'daybook-v1',lists:[{id:'b1',source_id:'monday:b1',name:'Shared'},{id:'b2',source_id:'monday:b2',name:'Shared'}],tasks:[
      {id:'i1',source_id:'monday:i1',list_id:'b1',title:'Parent',external_data:'{"columns":[{"title":"Link","text":"https://example.com"}]}',checklist:[{id:'c1',title:'Child',done:false,status:'doing',assignee:'Alex',due_date:'2026-11-01',external_data:'{"columns":[{"title":"Owner","text":"Alex"}]}'}]},
      {id:'i2',source_id:'monday:i2',list_id:'b2',title:'Other parent'}
    ]};
    assert.deepEqual(store.importData(payload),{imported:2,skipped:0});
    assert.deepEqual(store.importData(payload),{imported:0,skipped:2});
    const snapshot=store.snapshot(),first=snapshot.tasks.find(t=>t.source_id==='monday:i1');
    assert.equal(snapshot.lists.filter(l=>l.source_id?.startsWith('monday:')).length,2);
    assert.notEqual(snapshot.lists.find(l=>l.source_id==='monday:b1').id,snapshot.lists.find(l=>l.source_id==='monday:b2').id);
    assert.equal(first.checklist[0].assignee,'Alex');
    assert.equal(first.checklist[0].status,'doing');
    assert.equal(first.checklist[0].due_date,'2026-11-01');
    assert.match(first.checklist[0].external_data,/Owner/);
    assert.match(first.external_data,/Link/);
  } finally {store.db.close();}
});

test('Monday updates and attachment metadata import once and survive export', () => {
  const store=openStore(':memory:'),restored=openStore(':memory:');
  try {
    const payload={format:'daybook-v1',tasks:[],updates:[{id:'monday:sample-update',item_source_id:'monday:sample-item',creator:'Sample User',created_at:'2026-02-02T04:09:26.000Z',text_body:'',assets:[{id:'sample-asset',name:'photo.jpg',file_extension:'jpg',file_size:100}],replies:[]}]};
    assert.deepEqual(store.importData(payload),{imported:0,skipped:0,updatesImported:1,updatesSkipped:0});
    assert.deepEqual(store.importData(payload),{imported:0,skipped:0,updatesImported:0,updatesSkipped:1});
    assert.equal(store.snapshot().updates[0].assets[0].name,'photo.jpg');
    assert.equal(restored.importData(store.snapshot()).updatesImported,1);
    assert.equal(restored.snapshot().updates[0].item_source_id,'monday:sample-item');
  } finally {store.db.close();restored.db.close();}
});

test('board, group, column, and status edits persist with custom colors and archived items', () => {
  const s=openStore(':memory:');
  try {
    const board=s.addList({name:'Project'}),group=s.addGroup({list_id:board.id,name:'Sprint'});
    const item=s.insert({title:'Build',list_id:board.id,category:'Sprint'});
    const edited=s.updateList(board.id,{version:board.version,name:'Delivery',column_labels:{item:'Task',status:'Progress'},status_settings:{doing:{label:'In flight',color:'#123abc'},custom_review:{label:'Review',color:'#734abc'}}});
    assert.equal(edited.name,'Delivery');
    assert.equal(JSON.parse(edited.column_labels).status,'Progress');
    assert.equal(JSON.parse(edited.status_settings).doing.color,'#123abc');
    assert.throws(()=>s.updateList(board.id,{version:board.version,name:'Stale'}),/another tab/);
    s.updateGroup(group.id,{version:group.version,name:'Next sprint'});
    assert.equal(s.findTask(item.id).category,'Next sprint');
    const custom=s.update(item.id,{version:s.findTask(item.id).version,status:'custom_review'});
    assert.equal(custom.status,'custom_review');
    assert.throws(()=>s.updateList(board.id,{version:edited.version,status_settings:{}}),/Move items out/);
    const archived=s.update(item.id,{version:custom.version,archived:true});
    assert.ok(archived.archived_at);
    assert.equal(s.update(item.id,{version:archived.version,archived:false}).archived_at,null);
  } finally {s.db.close();}
});

test('item and subitem menu operations preserve relationships and order', () => {
  const s=openStore(':memory:');
  try {
    const list_id=s.snapshot().lists[0].id;
    const source=s.insert({title:'Source',list_id,category:'This week',notes:'Details'});
    const parent=s.insert({title:'Parent',list_id,category:'This week'});
    const below=s.createBelow(source.id);
    assert.ok(below.created_at<source.created_at);
    const converted=s.convertToSubitem(source.id,parent.id);
    assert.ok(converted.item.deleted_at);
    assert.equal(converted.parent.checklist[0].title,'Source');
    assert.equal(converted.parent.checklist[0].notes,'Details');
    const other=s.insert({title:'Other',list_id});
    const childId=converted.parent.checklist[0].id;
    s.moveSubitem(parent.id,childId,other.id);
    assert.equal(s.findTask(parent.id).checklist.length,0);
    assert.equal(s.findTask(other.id).checklist[0].id,childId);
    const restored=s.convertSubitemToItem(other.id,childId);
    assert.equal(restored.notes,'Details');
    assert.equal(s.findTask(other.id).checklist.length,0);
  } finally {s.db.close();}
});

test('tasks persist across restart; stale writes are rejected and trash can be restored', () => {
  const dir = mkdtempSync(join(tmpdir(),'daybook-store-')); const path = join(dir,'test.sqlite');
  let s = openStore(path);
  try {
    const list = s.snapshot().lists[0];
    const original = s.insert({title:'A real persistence check',list_id:list.id,checklist:[{title:'Step one',done:false}]});
    s.db.close(); s = openStore(path);
    assert.equal(s.findTask(original.id).title, original.title);
    assert.equal(s.findTask(original.id).checklist.length,1);
    const edited = s.update(original.id,{version:1,status:'doing'});
    assert.throws(()=>s.update(original.id,{version:1,title:'stale overwrite'}),/another tab/);
    const deleted = s.update(original.id,{version:edited.version,deleted:true});
    assert.ok(deleted.deleted_at);
    assert.throws(()=>s.update(original.id,{version:deleted.version,title:'edit deleted'}),/Restore/);
    const restored = s.update(original.id,{version:deleted.version,deleted:false});
    assert.equal(restored.deleted_at,null);
    assert.equal(restored.status,'doing');
  } finally {s.db.close(); rmSync(dir,{recursive:true,force:true});}
});
test('completion creates one next occurrence, retains history, and resets subtasks', () => {
  const s = openStore(':memory:');
  try {
    const t = s.insert({title:'Weekly review',list_id:s.snapshot().lists[0].id,repeat:'weekly',due_date:'2024-01-01',checklist:[{title:'Read notes',done:true}]});
    const done = s.update(t.id,{version:1,status:'done'});
    assert.ok(done.completed_at); assert.ok(done.next_task_id);
    const next = s.findTask(done.next_task_id);
    assert.ok(next.due_date > today()); assert.equal(next.checklist[0].done,false);
    assert.equal(next.status,'todo');
    const reopened = s.update(t.id,{version:done.version,status:'todo'});
    s.update(t.id,{version:reopened.version,status:'done'});
    assert.equal(s.snapshot().tasks.length,2);
  } finally {s.db.close();}
});
test('date calculation handles weekends, month ends, and invalid dates', () => {
  assert.equal(nextDate('2026-01-31','monthly','2026-01-31'),'2026-02-28');
  assert.equal(nextDate('2028-01-31','monthly','2028-01-31'),'2028-02-29');
  assert.equal(nextDate('2026-10-23','weekdays','2026-10-23'),'2026-10-26');
  assert.throws(()=>nextDate('2026-02-30','daily','2026-02-01'));
});
test('imports roll back on invalid rows and repeat imports skip source IDs', () => {
  const s = openStore(':memory:');
  try {
    const list_id = s.snapshot().lists[0].id;
    assert.throws(()=>s.importData({lists:[{id:'new',name:'Rollback list'}],tasks:[{title:'valid',list_id:'new'},{title:'',list_id}]}));
    assert.equal(s.snapshot().tasks.length,0); assert.equal(s.snapshot().lists.length,4);
    const input = {tasks:[{title:'Imported',list_id,source_id:'monday:123'}]};
    assert.equal(s.importData(input).imported,1);
    assert.equal(s.snapshot().tasks[0].next_task_id,null);
    assert.equal(s.importData(input).skipped,1);
    assert.throws(()=>s.importData({tasks:[null]}),/Invalid task/);
    assert.throws(()=>s.importData({tasks:[],lists:{name:'not an array'}}),/200 lists/);
    const snapshot = s.snapshot();
    assert.equal(s.importData(snapshot).skipped,1);
  } finally {s.db.close();}
});
test('backup JSON restores completion, trash and recurring relationships into a fresh database', () => {
  const original = openStore(':memory:'), restored = openStore(':memory:');
  try {
    const t = original.insert({title:'Daily',list_id:original.snapshot().lists[0].id,repeat:'daily'});
    const done = original.update(t.id,{version:1,status:'done'});
    original.update(done.next_task_id,{version:1,deleted:true});
    assert.equal(restored.importData(original.snapshot()).imported,2);
    const tasks = restored.snapshot().tasks;
    const imported = tasks.find(t=>t.status==='done');
    assert.ok(imported.completed_at);
    assert.ok(restored.findTask(imported.next_task_id).deleted_at);
  } finally {original.db.close();restored.db.close();}
});
