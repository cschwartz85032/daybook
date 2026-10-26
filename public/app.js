const icons = {
  check: '<path d="m5 12 4 4L19 6"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  calendar: '<rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4m8-4v4M4 10h16m-12 4h3m2 3h3"/>',
  list: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8m-8 4h8m-8 4h5"/>',
  done: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  flag: '<path d="M5 21V4c5-4 9 4 14 0v10c-5 4-9-4-14 0"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>', chevron: '<path d="m9 5 7 7-7 7"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>', menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  repeat: '<path d="m17 2 4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4m14-1v2a3 3 0 0 1-3 3H3"/>',
  leaf: '<path d="M20 3C8 1 1 8 5 15c5 9 18 1 15-12ZM5 20l10-12"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>', upload: '<path d="M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  logout: '<path d="M10 4H4v16h6m4-12 4 4-4 4m-6-4h10"/>', notes: '<path d="M4 4h16v12l-5 5H4zM8 8h8m-8 4h5m2 9v-5h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  camera:'<path d="M3 7h4l2-3h6l2 3h4v13H3z"/><circle cx="12" cy="13" r="4"/>',paperclip:'<path d="m8 12 6-6a4 4 0 0 1 6 6l-9 9a6 6 0 0 1-8-8l9-9"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.list}</svg>`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const $ = (s, context = document) => context.querySelector(s);
const app = $('#app'), editor = $('#editor'), small = $('#small-dialog');
let data = { tasks: [], lists: [], today: '', timeZone: 'America/Phoenix' }, auth, view = 'all', filter = 'all', search = '', sort = 'manual', selected, pendingImport, toastTimer, editChecklist = [], updateIndex = new Map(), updateFiles=[];
const statusNames = { todo:'To do', doing:'In progress', waiting:'Waiting', done:'Done' };
const repeatNames = { none:'Does not repeat', daily:'Every day', weekdays:'Every weekday', weekly:'Every week', monthly:'Every month' };
const priorityNames = { none:'No priority', low:'Low', medium:'Medium', high:'High' };
const active = t => !t.deleted_at && !t.archived_at && !listById(t.list_id)?.deleted_at && t.status !== 'done';
const listById = id => data.lists.find(l => l.id === id);
const formatDate = (value, options = { month:'short', day:'numeric' }) => value ? new Intl.DateTimeFormat('en-US', options).format(new Date(value + 'T12:00:00')) : '';
function notify(message, undo) {
  clearTimeout(toastTimer); const box = $('#toast');
  box.innerHTML = `<span>${esc(message)}</span>${undo ? '<button id="undo">Undo</button>' : ''}`; box.classList.add('show');
  if (undo) $('#undo').onclick = () => { box.classList.remove('show'); undo().catch(handleError); };
  toastTimer = setTimeout(() => box.classList.remove('show'), undo ? 10000 : 4500);
}
async function api(path, method = 'GET', body) {
  const response = await fetch(`./api/${path}`, { method, headers: { 'Content-Type':'application/json', ...(auth ? {'X-CSRF-Token': auth.csrf} : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) { const e = new Error(result.error || 'Request failed.'); e.status = response.status; throw e; }
  return result;
}
function handleError(e) {
  if (e.status === 401) { auth = null; editor.close(); small.close(); renderLogin(); }
  notify(e.message === 'Failed to fetch' ? 'Connection lost. Your changes were not saved. Please try again.' : e.message);
}
async function refresh(renderPage = true) { data = await api('data'); updateIndex=new Map();for(const u of data.updates||[]){if(!updateIndex.has(u.item_source_id))updateIndex.set(u.item_source_id,[]);updateIndex.get(u.item_source_id).push(u);} if (renderPage) render(); }
function options(values, current) { return Object.entries(values).map(([v, label]) => `<option value="${esc(v)}" ${v === current ? 'selected' : ''}>${esc(label)}</option>`).join(''); }
function listOptions(current) { return data.lists.filter(l=>!l.deleted_at).map(l => `<option value="${esc(l.id)}" ${l.id === current ? 'selected' : ''}>${esc(l.name)}</option>`).join(''); }
function renderLogin() {
  app.innerHTML = `<div class="login-page"><section class="login-intro"><div class="brand">${brand()}</div><div class="login-pitch"><div class="eyebrow">WORK, YOUR WAY</div><h1>Everything you need.<br>All on one board.</h1><p>Bring your plans, projects, and everyday work together.</p><div class="login-board-art" aria-hidden="true"><div><span></span><i></i><b></b></div><div><span></span><i></i><b></b></div><div><span></span><i></i><b></b></div><div><span></span><i></i><b></b></div></div></div><div class="bottom-note">Your boards for projects and everyday plans.</div></section><main class="login-main"><form class="login-form" id="login-form"><div class="eyebrow">YOUR WORKSPACE</div><h2>Welcome back.</h2><p>Sign in to pick up where you left off.</p><label class="field">Username<input name="username" autocomplete="username" required maxlength="80" autofocus></label><label class="field">Password<input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label><div class="form-error" role="alert"></div><button class="primary" type="submit">Sign in ${icon('arrow')}</button><div class="bottom-note">${icon('lock')}Your boards. Your workspace.</div></form></main></div>`;
  $('#login-form').onsubmit = async event => {
    event.preventDefault(); const form = event.currentTarget, button = $('button', form); button.disabled = true;
    try { auth = await api('login', 'POST', Object.fromEntries(new FormData(form))); await refresh(); const requested=new URLSearchParams(location.search).get('item');if(requested){const task=data.tasks.find(t=>t.id===requested);if(task)openEditor(task);} }
    catch (e) { $('.form-error', form).textContent = e.message === 'Failed to fetch' ? 'Cannot connect. Please try again.' : e.message; }
    finally { button.disabled = false; }
  };
}
async function changeTask(task, changes) {
  try { const result = await api(`tasks/${task.id}`, 'PATCH', { ...changes, version: task.version }); await refresh(); return result; }
  catch (e) { if (e.status === 409) await refresh(); throw e; }
}
function updateKeyFor(task) { return task.source_id || `daybook:${task.id}`; }
function subitemUpdateKey(child){return child.source_id||`${/^\d+$/.test(child.id)?'monday':'daybook'}:${child.id}`;}
function updatesFor(sourceId) { return updateIndex.get(sourceId) || []; }
function updateCards(sourceId) {
  return updatesFor(sourceId).map(u => `<article class="update-card"><div class="update-meta"><strong>${esc(u.creator)}</strong><time datetime="${esc(u.created_at)}">${esc(new Intl.DateTimeFormat('en-US',{dateStyle:'medium'}).format(new Date(u.created_at)))}</time></div>${u.text_body ? `<p>${esc(u.text_body).replace(/\n/g,'<br>')}</p>` : ''}${u.assets?.length ? `<div class="update-assets">${u.assets.map(a => { const ext=String(a.file_extension||'').toLowerCase().replace(/^\./,''); const path=`./api/assets/${encodeURIComponent(a.id)}.${encodeURIComponent(ext)}`; return `<a href="${path}" target="_blank" rel="noopener" aria-label="Open ${esc(a.name)}">${/^(jpg|jpeg|png|gif|webp)$/.test(ext)?`<img src="${path}" alt="${esc(a.name)}" loading="lazy">`:`${icon('download')} ${esc(a.name)}`}</a>`; }).join('')}</div>` : ''}</article>`).join('');
}
function renderUpdatesSection(task,key=updateKeyFor(task)) {
  const updates=updatesFor(key);
  return `<section id="item-updates" class="item-updates-section"><h3>Updates <span class="update-total">${updates.length}</span></h3>${task.deleted_at||task.archived_at?'':`<div class="update-compose"><textarea id="update-text" aria-label="Write an update" maxlength="50000" rows="3" placeholder="Write an update…"></textarea><div class="update-pending-assets" aria-live="polite"></div><div class="update-compose-actions"><div class="update-attach-actions"><button type="button" data-action="take-update-photo" aria-label="Take and attach a photo" title="Take a photo">${icon('camera')}</button><button type="button" data-action="attach-update-file" aria-label="Attach a document" title="Attach a document">${icon('paperclip')}</button><input id="update-photo-input" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" hidden><input id="update-document-input" type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,image/jpeg,image/png,image/gif,image/webp" multiple hidden></div><button type="button" class="primary" data-action="post-update" disabled>Post update</button></div><div class="update-error" role="alert"></div></div>`}<div class="update-list">${updates.length?updateCards(key):'<p class="hint">No updates yet.</p>'}</div></section>`;
}
function updateComposerState(root=editor){const field=$('#update-text',root),button=$('[data-action=post-update]',root);if(!field||!button)return;button.disabled=!field.value.trim()&&!updateFiles.length;$('.update-pending-assets',root).innerHTML=updateFiles.map((file,index)=>`<span>${icon(file.type.startsWith('image/')?'camera':'paperclip')}${esc(file.name)}<button type="button" data-remove-update-file="${index}" aria-label="Remove ${esc(file.name)}">×</button></span>`).join('');root.querySelectorAll('[data-remove-update-file]').forEach(b=>b.onclick=()=>{updateFiles.splice(Number(b.dataset.removeUpdateFile),1);updateComposerState(root);});}
function addUpdateFiles(files,root=editor){const allowed=/\.(jpg|jpeg|png|gif|webp|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv)$/i;for(const file of files){if(!allowed.test(file.name)||file.size>5*1024*1024){$('.update-error',root).textContent=`${file.name}: choose a supported file under 5 MB.`;continue;}if(updateFiles.length>=10){$('.update-error',root).textContent='Attach up to 10 files.';break;}updateFiles.push(file);}updateComposerState(root);}
async function takeUpdatePhoto(root=editor){
  if(!navigator.mediaDevices?.getUserMedia){$('#update-photo-input',root).click();return;}
  let stream;try{stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'},audio:false});}catch{$('#update-photo-input',root).click();return;}
  const camera=document.createElement('dialog');camera.className='camera-dialog';camera.innerHTML=`<div class="dialog-head"><h2>Take a photo</h2><button type="button" class="icon-button" id="close-camera" aria-label="Close camera">${icon('close')}</button></div><div class="dialog-body"><video id="update-camera-preview" autoplay playsinline style="width:100%;max-height:55vh;background:#111"></video><p class="hint">Position the photo, then capture it.</p><button type="button" class="primary" id="capture-update-photo">${icon('camera')} Capture photo</button></div>`;document.body.append(camera);
  const stop=()=>camera.close();camera.onclose=()=>{stream.getTracks().forEach(track=>track.stop());camera.remove();};camera.showModal();$('#update-camera-preview',camera).srcObject=stream;$('#close-camera',camera).onclick=stop;
  $('#capture-update-photo',camera).onclick=()=>{const video=$('#update-camera-preview',camera),canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;canvas.getContext('2d').drawImage(video,0,0);canvas.toBlob(blob=>{if(blob)addUpdateFiles([new File([blob],`photo-${Date.now()}.jpg`,{type:'image/jpeg'})],root);stop();},'image/jpeg',.88);};
}
function bindUpdateComposer(root,task,child=null){const field=$('#update-text',root),button=$('[data-action=post-update]',root);if(!field||!button)return;field.oninput=()=>updateComposerState(root);field.onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();postUpdate(task,child,root);}};button.onclick=()=>postUpdate(task,child,root);$('[data-action=take-update-photo]',root).onclick=()=>takeUpdatePhoto(root);$('[data-action=attach-update-file]',root).onclick=()=>$('#update-document-input',root).click();$('#update-photo-input',root).onchange=e=>addUpdateFiles(e.target.files,root);$('#update-document-input',root).onchange=e=>addUpdateFiles(e.target.files,root);}
async function fileBase64(file){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});}
async function postUpdate(task,child=null,root=editor) {
  const field=$('#update-text',root),button=$('[data-action=post-update]',root),message=field.value.trim();
  if(!message&&!updateFiles.length)return;
  button.disabled=true;$('.update-error',root).textContent='';
  try {
    const assets=[];for(const file of updateFiles)assets.push(await api('uploads','POST',{name:file.name,bytes:await fileBase64(file)}));
    const update=await api(child?`tasks/${task.id}/subitems/${child.id}/updates`:`tasks/${task.id}/updates`,'POST',{text_body:message,assets});
    data.updates.unshift(update);
    if(!updateIndex.has(update.item_source_id))updateIndex.set(update.item_source_id,[]);
    updateIndex.get(update.item_source_id).unshift(update);
    field.value='';
    updateFiles=[];updateComposerState(root);
    $('.update-total',root).textContent=updatesFor(update.item_source_id).length;
    $('.update-list',root).innerHTML=updateCards(update.item_source_id);
    renderTasks();
    notify('Update posted.');
  } catch(e) { $('.update-error',root).textContent=e.message;button.disabled=false; }
}
function openEditor(task, defaults = {}) {
  closePopover(); if (small.open) small.close();
  updateFiles=[];
  selected = task || null;
  const t = task || {title:'',notes:'',list_id:listById(view)?.id || data.lists.find(l=>!l.deleted_at)?.id,status:'todo',priority:'none',due_date:view === 'today' ? data.today : '',category:'',quantity:'',repeat:'none',checklist:[],assignee:'',...defaults};
  editChecklist = structuredClone(t.checklist);
  editor.innerHTML = `<form id="task-form"><div class="dialog-head"><h2 id="editor-heading">${task ? 'Item details' : 'New item'}</h2><button type="button" class="icon-button" data-action="close-editor" aria-label="Close task editor">${icon('close')}</button></div><div class="dialog-body"><label class="field">Item name<input class="title-input" name="title" value="${esc(t.title)}" required maxlength="500" placeholder="Name your item"></label><div class="dialog-grid"><label class="field">Board<select name="list_id">${listOptions(t.list_id)}</select></label><label class="field">Status<select name="status">${options(statusLabelsFor(t.list_id),t.status)}</select></label><label class="field">Due date<input name="due_date" type="date" value="${esc(t.due_date)}" min="1900-01-01" max="2200-12-31"></label><label class="field">Priority<select name="priority">${options(priorityNames,t.priority)}</select></label><label class="field">Group<input list="group-options" name="category" maxlength="100" value="${esc(t.category)}" placeholder="e.g. This week, Next week"></label><datalist id="group-options">${(data.groups||[]).filter(g=>g.list_id===t.list_id).map(g=>`<option value="${esc(g.name)}"></option>`).join('')}</datalist><label class="field">Person<input name="assignee" value="${esc(t.assignee)}" maxlength="80" placeholder="Unassigned"></label><label class="field">Quantity<input name="quantity" maxlength="100" value="${esc(t.quantity)}" placeholder="e.g. 2, one box"></label></div><label class="field">Repeat<select name="repeat">${options(repeatNames,t.repeat)}</select></label><p class="hint">Completing a repeating task creates the next occurrence. The completed task stays in your history.</p><label class="field">Notes<textarea name="notes" rows="4" maxlength="50000" placeholder="A few details, a link, a reminder…">${esc(t.notes)}</textarea></label><div class="subtask-heading"><span>Subitems</span><button type="button" class="quiet-link" data-action="add-subtask">${icon('plus')}Add subitem</button></div><div class="checklist" id="checklist"></div>${t.next_task_id ? '<p class="hint">The next occurrence has already been created. Reopening this task will keep that occurrence.</p>' : ''}<div class="form-error" role="alert"></div></div><div class="dialog-footer">${task ? `<button type="button" class="quiet-link ${t.deleted_at ? '' : 'danger'}" data-action="${t.deleted_at ? 'restore-editor' : 'delete'}">${icon(t.deleted_at ? 'repeat' : 'trash')}${t.deleted_at ? 'Restore item' : 'Move to trash'}</button>` : ''}<div class="actions"><button type="button" class="secondary" data-action="close-editor">Cancel</button><button type="submit" class="primary" ${t.deleted_at ? 'disabled' : ''}>${task ? 'Save changes' : 'Add item'}</button></div></div></form>`;
  $('[name=priority]',editor).closest('label').insertAdjacentHTML('beforebegin',`<label class="field">Completed On<input name="completed_on" type="date" value="${esc(t.completed_on||'')}" min="1900-01-01" max="2200-12-31"></label>`);
  renderChecklist();
  if(task){$('#checklist').insertAdjacentHTML('afterend',renderUpdatesSection(task));bindUpdateComposer(editor,task);}
  if(task?.external_data){try{const source=JSON.parse(task.external_data);if(source.columns?.length)$('#checklist').insertAdjacentHTML('afterend',`<details class="imported-fields"><summary>Monday fields (${source.columns.length})</summary><dl>${source.columns.map(c=>`<div><dt>${esc(c.title)}</dt><dd>${esc(c.text||c.value||'—')}</dd></div>`).join('')}</dl></details>`);}catch{}}
  $('#task-form').onsubmit = saveTask;
  $('[name=list_id]',editor).onchange=e=>{ $('#group-options').innerHTML=(data.groups||[]).filter(g=>g.list_id===e.target.value).map(g=>`<option value="${esc(g.name)}"></option>`).join(''); $('[name=status]',editor).innerHTML=options(statusLabelsFor(e.target.value),'todo'); };
  if (!editor.open) editor.showModal();
  $('input[name=title]',editor).focus();
}
function readChecklist() {
  editChecklist = [...document.querySelectorAll('.checklist-line')].map(row => { const previous=editChecklist.find(c=>c.id===row.dataset.id)||{}; const done=$('input[type=checkbox]',row).checked; return {...previous,id:row.dataset.id,title:$('input[type=text]',row).value,done,status:done?'done':previous.status==='done'?'todo':previous.status||'todo'}; });
}
function renderChecklist() {
  $('#checklist').innerHTML = editChecklist.map((c,i) => `<div class="checklist-line" data-id="${esc(c.id)}"><input type="checkbox" aria-label="Complete subtask ${i+1}" ${c.done ? 'checked' : ''}><input type="text" value="${esc(c.title)}" aria-label="Subtask ${i+1}" maxlength="500" placeholder="A smaller step"><button type="button" class="icon-button" data-action="remove-subtask" data-index="${i}" aria-label="Remove subtask ${i+1}">${icon('close')}</button></div>`).join('');
}
async function saveTask(event) {
  event.preventDefault(); const form = event.currentTarget, button = $('button[type=submit]',form); button.disabled = true;
  readChecklist();
  const value = { ...Object.fromEntries(new FormData(form)), checklist: editChecklist.filter(c => c.title.trim()) };
  try { if (selected) await changeTask(selected,value); else { await api('tasks','POST',value); await refresh(); } editor.close(); notify(selected ? 'Item saved.' : 'Item added.'); }
  catch (e) { $('.form-error',form).textContent = e.message; button.disabled = false; }
}
function openListDialog() {
  small.innerHTML = `<form id="list-form"><div class="dialog-head"><h2 id="small-heading">Create a board</h2><button type="button" class="icon-button" data-action="close-small" aria-label="Close">${icon('close')}</button></div><div class="dialog-body"><label class="field">Board name<input name="name" maxlength="80" required placeholder="e.g. Weekend projects"></label><label class="field">Color<input name="color" type="color" value="#548775"></label><div class="form-error" role="alert"></div></div><div class="dialog-footer"><div class="actions"><button type="button" class="secondary" data-action="close-small">Cancel</button><button class="primary" type="submit">Create board</button></div></div></form>`;
  small.showModal();
  $('#list-form').onsubmit = async e => { e.preventDefault(); const form = e.currentTarget, b = $('button[type=submit]',form); b.disabled = true; try { const list = await api('lists','POST',Object.fromEntries(new FormData(form))); view = list.id; filter = 'all'; await refresh(); small.close(); notify('Board created.'); } catch (error) { $('.form-error',form).textContent = error.message; b.disabled = false; } };
}
function parseCSV(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i=0; i<text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i+1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(field); field=''; }
    else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && text[i+1] === '\n') i++; row.push(field); if (row.some(v=>v.trim())) rows.push(row); row=[]; field=''; }
    else field += c;
  }
  if (quoted) throw new Error('This CSV has an unclosed quote.');
  row.push(field); if (row.some(v=>v.trim())) rows.push(row);
  return rows;
}
function csvImport(text, listId) {
  const rows = parseCSV(text.replace(/^\uFEFF/,''));
  if (rows.length < 2) throw new Error('The CSV needs a header row and at least one task.');
  const headers = rows.shift().map(h=>h.trim().toLowerCase());
  const find = (...names) => headers.findIndex(h=>names.includes(h));
  const nameIndex = find('title','name','task','item');
  if (nameIndex < 0) throw new Error('The CSV needs a Title, Name, Task, or Item column.');
  const field = (row,...names) => row[find(...names)]?.trim() || '';
  return { tasks:rows.filter(row=>row[nameIndex]?.trim()).map(row => {
    const status = field(row,'status','completed').toLowerCase();
    const due = field(row,'due date','due_date','due by','date');
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error('Use YYYY-MM-DD in the CSV due-date column.');
    return {title:row[nameIndex],list_id:listId,notes:field(row,'notes','description'),status:['done','completed','yes','true'].includes(status)?'done':['doing','working on it','in progress'].includes(status)?'doing':['waiting','stuck'].includes(status)?'waiting':'todo',priority:['low','medium','high'].includes(field(row,'priority').toLowerCase())?field(row,'priority').toLowerCase():'none',due_date:due,category:field(row,'category','group','section'),assignee:field(row,'person','assignee','owner'),quantity:field(row,'quantity','qty'),source_id:field(row,'id','item id') ? `csv:${listId}:${field(row,'id','item id')}`:null};
  }) };
}
function openImport() {
  pendingImport = null;
  small.innerHTML = `<div class="dialog-head"><h2 id="small-heading">Import your boards</h2><button class="icon-button" data-action="close-small" aria-label="Close">${icon('close')}</button></div><div class="dialog-body"><label class="field">Choose an export<input id="import-file" type="file" accept=".json,.csv,application/json,text/csv"></label><label class="field">Destination for CSV tasks<select id="import-list">${listOptions(listById(view)?.id || data.lists.find(l=>!l.deleted_at)?.id)}</select></label><p class="hint">Daybook JSON preserves lists, subtasks, dates, and history. CSV accepts Title, Status, Priority, Due date (YYYY-MM-DD), Notes, Category, Quantity, and ID columns. Maximum file size: 8 MB.</p><div id="import-preview"></div><div class="form-error" role="alert"></div></div><div class="dialog-footer"><div class="actions"><button class="secondary" data-action="close-small">Cancel</button><button class="primary" data-action="confirm-import" disabled>Import tasks</button></div></div>`;
  small.showModal();
  const preview = async () => {
    pendingImport = null; $('[data-action=confirm-import]',small).disabled = true; $('.form-error',small).textContent = ''; $('#import-preview').innerHTML='';
    try {
      const file = $('#import-file').files[0]; if (!file) return;
      if (file.size > 8 * 1024 * 1024) throw new Error('Choose a file smaller than 8 MB.');
      const text = await file.text(); pendingImport = file.name.toLowerCase().endsWith('.csv') ? csvImport(text,$('#import-list').value) : JSON.parse(text);
      if (!Array.isArray(pendingImport.tasks) || pendingImport.tasks.length > 20000) throw new Error('Choose a valid task export (up to 20,000 tasks).');
      $('#import-preview').innerHTML = `<div class="import-summary"><p><strong>${pendingImport.tasks.length} tasks</strong> ready to import</p><p>${pendingImport.lists?.length || 1} lists · Existing tasks will be kept.</p></div><p class="hint">Matching source IDs are skipped. CSV files without IDs create new tasks each time.</p>`;
      $('[data-action=confirm-import]',small).disabled = false;
    } catch (e) { pendingImport = null; $('.form-error',small).textContent = e.message; }
  };
  $('#import-file').onchange = preview; $('#import-list').onchange = preview;
}
async function init() { try { auth = await api('session'); await refresh(); const requested=new URLSearchParams(location.search).get('item'); if(requested){const task=data.tasks.find(t=>t.id===requested);if(task)openEditor(task);else notify('Item not found.');} } catch (e) { if (e.status === 401) renderLogin(); else { app.innerHTML='<div class="boot">Could not connect to your daybook. Please refresh to try again.</div>'; notify(e.message); } } }
