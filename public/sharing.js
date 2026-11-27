const editableBoard = id => ['owner','edit'].includes(listById(id)?.role);
const firstEditableBoard = () => data.lists.find(b => !b.deleted_at && editableBoard(b.id));
const editingHere = () => listById(view) ? editableBoard(view) : Boolean(firstEditableBoard());

function applyBoardPermissions() {
  if (data.workspace_owner) return;
  const hide = (root, selectors) => root.querySelectorAll(selectors).forEach(el => { el.hidden=true; });
  hide(app,'[data-action="import"],[data-action="add-list"]');
  const readOnly = !editingHere();
  if (readOnly) hide(app,'.split-button,[data-action="new"],[data-action="add-group"],.kanban-add');
  for (const button of app.querySelectorAll('[data-action="calendar-add"]')) button.disabled=readOnly;
  for (const heading of app.querySelectorAll('[data-action="edit-board-name"],[data-action="edit-column-name"],[data-action="edit-group-name"]')) {
    const boardId = heading.dataset.listId || view;
    if (!editableBoard(boardId)) heading.disabled=true;
  }
  for (const group of app.querySelectorAll('.board-group')) {
    const info = renderedGroups[group.dataset.group];
    if (!editableBoard(info.defaults.list_id)) hide(group,'.group-add,.group-drag-handle,.group-more,.column-more,[data-action="add-column-menu"]');
    const select = group.querySelector('[data-select-group]');
    if (select && !info.tasks.some(t=>editableBoard(t.list_id))) select.disabled=true;
  }
  const tasks = new Map(data.tasks.map(t=>[t.id,t]));
  for (const row of app.querySelectorAll('.item-row,.subitem-panel-row,.kanban-card')) {
    if (editableBoard(tasks.get(row.dataset.id)?.list_id)) continue;
    hide(row,'.row-more,.subitem-quick-add,.item-drag-handle,[data-action="item-menu"],[data-action="restore"],[data-action="restore-archive"],[data-action="edit-subitem-status-labels"]');
    for (const field of row.querySelectorAll('input,select,.person-cell,.priority-pill')) field.disabled=true;
  }
}

function roleSelect(role, allowEdit, label) {
  return `<select name="role" aria-label="${esc(label)}"><option value="view">View</option>${allowEdit ? `<option value="edit" ${role==='edit'?'selected':''}>Edit</option>` : ''}</select>`;
}
function sharingCheckbox(checked) {
  return `<label class="sharing-check"><input type="checkbox" name="sharing" ${checked?'checked':''}> Sharing Allowed</label>`;
}
function smsConfirmation() {
  const script=esc(data.sms_disclosure);
  return `<div class="sms-consent"><p>Read this to the recipient before sending a text.</p>
    <blockquote>${script}</blockquote>
    ${data.sms_program?'<p><a href="./sms/terms" target="_blank" rel="noopener">SMS terms</a> · <a href="./sms/privacy" target="_blank" rel="noopener">Privacy</a></p>':''}
    <label class="sharing-check"><input type="checkbox" name="sms_consent"> ${esc(data.sms_consent_notice)}</label></div>`;
}
function invitationUrl(boardId,id) {
  const url = new URL('./',location.href);
  url.searchParams.set('board',boardId);
  url.searchParams.set('invite',id);
  return url.href;
}
function deliveryButtons(id) {
  return `<div class="invite-delivery" data-invitation="${esc(id)}">
    ${navigator.share ? `<button class="text-button" type="button" data-deliver="share">${icon('upload')}Share invitation</button>` : ''}
    <button class="text-button" type="button" data-deliver="copy">${icon('link')}Copy link</button></div>`;
}
function setupDelivery(board,id,setup) {
  const link=invitationUrl(board.id,id);
  const message=`You’re invited to ${board.name} on Daybook. Open ${link} and enter setup code ${setup.code} to choose your password. The code expires in 30 minutes.`;
  const isPhone=setup.contact.startsWith('+');
  const address=setup.contact.split('@').map(encodeURIComponent).join('@');
  const target=isPhone ? 'sms:'+setup.contact+'?body='+encodeURIComponent(message) :
    'mailto:'+address+'?subject='+encodeURIComponent('Daybook invitation')+'&body='+encodeURIComponent(message);
  return `<div class="account-delivery"><a class="primary" href="${esc(target)}">${isPhone?'Text invitation':'Email invitation'}</a>
    <button class="secondary" type="button" data-copy-message="${esc(message)}">Copy invitation message</button>
    <details><summary>Send the code separately</summary><p>Send <strong>${esc(setup.code)}</strong> to ${esc(setup.contact)}. It expires in 30 minutes.</p></details></div>`;
}
function textStatus(sms) {
  const labels={unsent:'Text has not been sent.',submitting:'Submitting text…',accepted:'Text accepted by Twilio.',scheduled:'Text scheduled.',
    queued:'Text queued.',sending:'Sending text…',sent:'Text sent to carrier.',delivered:'Text delivered.',undelivered:'Text undelivered.',
    failed:'Text failed.',canceled:'Text canceled.',limited:'Text paused.',unknown:'Delivery unconfirmed. Check the status before resending.'};
  return [labels[sms.state],sms.reason].filter(Boolean).join(' ');
}
function memberRow(person,owner) {
  const pending=person.state==='pending';
  const permission=person.role==='edit'?'Edit':'View';
  const phone=person.username.startsWith('+');
  const canPrepare=owner && pending && person.needs_setup && !(phone && data.server_sms_only) && (!person.sms || !data.sms_enabled || person.sms.manual_setup);
  return `<form class="share-person" data-member="${esc(person.id)}">
    <details><summary class="share-person-line">
      <span class="avatar small" aria-hidden="true">${phone?icon('person'):initial(person.username)}</span>
      <span class="share-identity"><strong>${esc(person.username)}</strong>
        <small>${pending?'Pending invitation':'Invited by '+esc(person.inviter)}${person.sharing?' · Sharing Allowed':''}</small></span>
      <span class="share-role">${permission}</span>${icon('chevron')}</summary>
      <div class="share-person-settings">
        ${owner?`<div class="share-permissions"><label class="field">Permission${roleSelect(person.role,true,'Permission for '+person.username)}</label>${sharingCheckbox(person.sharing)}
          <button class="secondary" type="submit" disabled>Save</button></div>`:''}
        ${person.sms?`<p class="share-status" role="status">${esc(textStatus(person.sms))}</p>`:''}
        ${pending && person.sms && data.sms_enabled?smsConfirmation():''}
        ${pending?`<div class="share-delivery-actions">
          ${canPrepare?`<button class="secondary" type="button" data-issue-code>${phone?'Prepare text message':'Prepare email'}</button>`:''}
          ${person.sms && data.sms_enabled?`<button class="secondary" type="button" data-send-text disabled>${person.sms.state==='unsent'?'Send text':'Resend text'}</button>`:''}
          ${deliveryButtons(person.id)}</div>`:''}
        ${owner?`<button class="quiet-link danger" type="button" data-remove>${pending?'Cancel invitation':'Remove access'}</button>`:''}
      </div></details></form>`;
}
async function openSharing(board, issued) {
  closePopover();
  const people = await api(`lists/${board.id}/members`);
  const owner = board.role === 'owner';
  const dialog = $('#share-dialog');
  dialog.innerHTML = `<div class="dialog-head"><div class="share-title-group"><span class="share-board-icon">${icon('board')}</span><div><h2 id="share-title">Share board</h2><p class="automation-subtitle">${esc(board.name)}</p></div></div>
    <button type="button" class="icon-button" aria-label="Close" data-dismiss>${icon('close')}</button></div>
    <div class="dialog-body"><form id="board-invite">
      <div class="share-fields"><label class="field">Email or mobile number<input name="contact" required maxlength="254" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="off" placeholder="Enter an email or phone number"></label>
      <label class="field">Permission ${roleSelect('view',board.role!=='view','Invitation permission')}</label></div>
      <div data-mobile-delivery hidden>${data.sms_enabled?smsConfirmation():data.server_sms_only?'<p class="share-status">Text delivery is awaiting sender registration. You can save this invitation and send the text when delivery becomes available.</p>':''}</div>
      <div class="share-invite-actions">${owner?sharingCheckbox(false):''}<button class="primary" type="submit">${icon('plus')}Invite</button></div></form>
    ${issued?`<section class="invite-ready" role="status"><strong>Invitation ready for ${esc(issued.contact)}</strong>
      ${issued.sms?`<p>${esc(textStatus(issued.sms))}</p>`:issued.setup?setupDelivery(board,issued.id,issued.setup):issued.needs_setup?'<p>The board owner can send the setup code from People with access.</p>':''}
      ${deliveryButtons(issued.id)}</section>`:''}
    ${owner || people.length?`<section class="share-people"><div class="automation-section-head"><h3>${owner?'People with access':'Your pending invitations'}</h3>
      ${data.sms_enabled && people.some(person=>person.sms)?'<button class="quiet-link" type="button" data-refresh-status>Refresh text status</button>':''}</div>
      ${owner?`<div class="share-person-line share-owner"><span class="avatar small" aria-hidden="true">${initial(auth.username)}</span><strong>${esc(auth.username)}</strong><span class="share-role">Owner</span></div>`:''}
      ${people.map(person=>memberRow(person,owner)).join('')}
      </section>`:''}
    <div class="form-error" role="alert"></div></div>`;
  if (!dialog.open) dialog.showModal();
  dialog.onclick=async event=>{
    const button=event.target.closest('[data-copy-message]');
    if (!button) return;
    try { await navigator.clipboard.writeText(button.dataset.copyMessage); notify('Invitation message copied.'); }
    catch { prompt('Copy invitation message',button.dataset.copyMessage); }
  };
  const error = $('.form-error',dialog);
  const refreshStatus=$('[data-refresh-status]',dialog);
  if (refreshStatus) refreshStatus.onclick=()=>openSharing(board).catch(e=>{ error.textContent=e.message; });
  $('[data-dismiss]',dialog).onclick = () => dialog.close();
  const invite = $('#board-invite',dialog);
  const mobileDelivery=$('[data-mobile-delivery]',invite);
  invite.elements.contact.oninput=()=>{
    const contact=invite.elements.contact.value.trim();
    mobileDelivery.hidden=!/^\+?[\d\s().-]+$/.test(contact);
    const consent=invite.elements.sms_consent;
    if (consent) { consent.checked=false; consent.required=!mobileDelivery.hidden; }
  };
  invite.onsubmit = async event => {
    event.preventDefault();
    const submit = $('button[type=submit]',invite);
    submit.disabled = true;
    try {
      const contact = invite.elements.contact.value.trim();
      const result = await api(`lists/${board.id}/members`,'POST',{contact,role:invite.elements.role.value,sharing:!!invite.elements.sharing?.checked,sms_consent:!!invite.elements.sms_consent?.checked});
      await openSharing(board,{contact,...result});
      $('.invite-ready a,.invite-ready button',dialog)?.focus();
    } catch (e) { error.textContent=e.message; submit.disabled=false; }
  };
  for (const form of dialog.querySelectorAll('[data-member]')) {
    const save = $('button[type=submit]',form);
    const person = people.find(p=>p.id===form.dataset.member);
    const resend=$('[data-send-text]',form);
    if (resend) form.elements.sms_consent.onchange=event=>{resend.disabled=!event.target.checked;};
    if (resend) resend.onclick=async()=>{
      resend.disabled=true;
      try {
        const status=await api(`lists/${board.id}/members/${person.id}/text`,'POST',{sms_consent:form.elements.sms_consent.checked});
        await openSharing(board);
        notify(textStatus(status));
      } catch (e) { error.textContent=e.message; form.elements.sms_consent.checked=false; resend.disabled=true; }
    };
    if (!owner) { form.onsubmit=e=>e.preventDefault(); continue; }
    const setupButton = $('[data-issue-code]',form);
    if (setupButton) setupButton.onclick = async () => {
      setupButton.disabled=true;
      try {
        const setup=await api(`lists/${board.id}/members/${person.id}/setup-code`,'POST',{});
        setupButton.outerHTML=setupDelivery(board,person.id,setup);
        $('.account-delivery a',form)?.focus();
      } catch (e) { error.textContent=e.message; setupButton.disabled=false; }
    };
    form.onchange = event => { if (['role','sharing'].includes(event.target.name)) save.disabled=false; };
    async function change(changes) {
      try {
        await api(`lists/${board.id}/members/${person.id}`,'PATCH',changes);
        await openSharing(board);
        notify(changes.remove?'Access removed.':'Permissions saved.');
      } catch (e) { error.textContent=e.message; }
    }
    form.onsubmit = event => {
      event.preventDefault();
      const changes = {};
      if (form.elements.role.value!==person.role) changes.role=form.elements.role.value;
      if (form.elements.sharing.checked!==Boolean(person.sharing)) changes.sharing=form.elements.sharing.checked;
      void change(changes);
    };
    $('[data-remove]',form).onclick = () => {
      if (confirm(`Remove ${person.username}’s access to ${board.name}?`)) void change({remove:true});
    };
  }
  for (const button of dialog.querySelectorAll('[data-deliver]')) {
    button.onclick = async () => {
      const url = invitationUrl(board.id,button.closest('[data-invitation]').dataset.invitation);
      try {
        if (button.dataset.deliver==='share') await navigator.share({title:board.name,url});
        else if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(url); notify('Invitation link copied.'); }
        else prompt('Copy invitation link',url);
      } catch (e) { if (e.name!=='AbortError') prompt('Copy invitation link',url); }
    };
  }
}

function openInvitation(invite) {
  const permission = invite.role==='edit'?'Edit':'View';
  infoDialog('Board invitation',`<p><strong>${esc(invite.inviter)}</strong> invited you to <strong>${esc(invite.name)}</strong>.</p>
    <p>Permission · ${permission}${invite.sharing?' · Sharing Allowed':''}</p>
    <button class="primary" id="accept-board">Accept invitation</button><div class="form-error" role="alert"></div>`);
  $('#accept-board',small).onclick = async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const {list_id} = await api(`invitations/${invite.id}/accept`,'POST',{});
      await refresh(false);
      small.close();
      navigate(list_id);
    } catch (e) { $('.form-error',small).textContent=e.message; button.disabled=false; }
  };
}

function openRequestedContent() {
  const query = new URLSearchParams(location.search);
  const invitation = data.invitations.find(i=>i.id===query.get('invite'));
  const requestedBoard=listById(query.get('board'));
  const task=data.tasks.find(t=>t.id===query.get('item'));
  const board=task ? listById(task.list_id) : requestedBoard;
  const available=board && !board.deleted_at;
  const keepInvite=query.has('invite') && (invitation || !available);
  const target=available && !keepInvite ? board.id : data.last_board_id || 'all';
  navigate(target,{preserveLink:Boolean(keepInvite || task),remember:Boolean(available && !keepInvite)});
  if (invitation) { openInvitation(invitation); return; }
  if (query.has('board') && (!requestedBoard || requestedBoard.deleted_at)) {
    if (query.has('invite')) {
      infoDialog('Board invitation',`<p>This invitation is unavailable to ${esc(auth.username)}.</p><button class="secondary" id="switch-invite-account">Use another account</button>`);
      $('#switch-invite-account',small).onclick=async()=>{
        try { await api('logout','POST',{}); auth=null; small.close(); await showSignInOrSetup(); } catch (e) { handleError(e); }
      };
    } else notify('Board unavailable for this account.');
  }
  if (query.has('item')) {
    if (task) openEditor(task);
    else notify('Item unavailable for this account.');
  }
}

async function showSignInOrSetup() {
  renderLogin();
  const id=new URLSearchParams(location.search).get('invite');
  if (!id || !/^[a-z0-9-]{1,80}$/i.test(id)) return;
  const {needs_setup}=await api(`invitations/${id}/entry`);
  if (!needs_setup || !$('#login-form')) return;
  $('.login-main').innerHTML=`<form id="setup-account" class="login-form"><h2>Set up your Daybook account</h2>
    <p>Use the contact and setup code from your invitation.</p>
    <label class="field">Email or mobile number<input name="contact" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="254" required></label>
    <label class="field">Setup code<input name="code" autocomplete="one-time-code" autocapitalize="characters" maxlength="32" required></label>
    <label class="field">Choose a password<input name="password" type="password" minlength="14" maxlength="1024" autocomplete="new-password" required></label>
    <small>Use at least 14 characters.</small><div class="form-error" role="alert"></div>
    <button class="primary" type="submit">Create account and open board</button><button type="button" class="quiet-link" id="existing-signin">Sign in to an existing account</button></form>`;
  $('#existing-signin').onclick=renderLogin;
  const form=$('#setup-account');
  form.elements.contact.focus();
  form.onsubmit=async e=>{
    e.preventDefault();
    const submit=$('[type=submit]',form);
    submit.disabled=true;
    try {
      const result=await api(`invitations/${id}/activate`,'POST',Object.fromEntries(new FormData(form)));
      auth={username:result.username,csrf:result.csrf};
      await refresh(false);
      navigate(result.list_id);
    } catch (error) { $('.form-error',form).textContent=error.message; submit.disabled=false; }
  };
}
