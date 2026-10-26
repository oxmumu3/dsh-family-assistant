'use strict';
(() => {
  const labels={queued:'等待执行',running:'正在处理',needs_approval:'等待审批',needs_input:'需要补充',succeeded:'已完成',failed:'未完成',cancelled:'已取消',cancelling:'取消核对中',unknown:'结果待核对'};
  const tools={ai_digest:{title:'AI 信息精选',description:'读取你指定的本地日报，交给这位家人。'},weather:{title:'天气简报',description:'围绕家人所在的城市，准备出行需要的信息。'},presentation:{title:'PPT 制作',description:'家人在微信发来材料后，继续制作和修改可编辑 PPT。'}};
  window.createLeleCapabilities=function({getState,request,refresh,openDialog,closeDialog,openPerson,editPerson,addFamily,chooseProject,openNativeSession,onError=()=>{}}){
    const document=window.document||globalThis.document;
    const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined&&text!==null)n.textContent=text;if(cls)n.className=cls;return n;};
    const button=(label,fn,cls='secondary')=>{const b=el('button',label,cls);b.type='button';b.addEventListener('click',()=>{void fn(b);});return b;};
    const input=(name,type='text',value='')=>{const n=el('input');n.name=name;n.type=type;n.value=value;return n;};
    const field=(form,label,control)=>{const wrap=el('label',null,'lele-field');wrap.append(el('span',label),control);form.append(wrap);return control;};
    const select=(name,rows,value)=>{const s=el('select');s.name=name;for(const row of rows){const o=el('option',row.label);o.value=row.value;s.append(o);}s.value=value??rows[0]?.value??'';return s;};
    const items=value=>Array.isArray(value)?value:Array.isArray(value?.items)?value.items:[];
    const state=()=>getState()||{},people=()=>state().people||[],person=id=>people().find(p=>p.id===id);
    const time=at=>{try{return new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short'}).format(new Date(at));}catch{return'时间待确认';}};
    const note=(parent,value,cls='hint')=>parent.append(el('p',value,cls));
    const signature=(value)=>JSON.stringify(value);
    let activeView='chat';
    let familyRoot=null,toolRoot=null,harnessRoot=null,historyPerson='',historyMobile='list',historyVersion=0,dialogVersion=0,toolPerson='';
    const histories=new Map(),pendingButtons=new Set();
    let ownerIdentity='',ownerGeneration=0;
    const messageDraftKey='lele.owner-history-drafts.v1',messageDrafts=new Map();
    let messageFocus=null,draftStorageUnavailable=false,historyScroll=null,historyScrollPerson='';
    const bindingGeneration=p=>Number.isSafeInteger(p?.binding?.generation)&&p.binding.generation>0?p.binding.generation:0;
    const historyAnchor=p=>signature([bindingGeneration(p),p?.binding?.lastInboundAt??null,p?.binding?.lastOutboundAt??null]);
    function saveMessageDrafts(){try{if(!ownerIdentity){window.sessionStorage?.removeItem(messageDraftKey);return;}window.sessionStorage?.setItem(messageDraftKey,JSON.stringify({ownerId:ownerIdentity,drafts:[...messageDrafts].map(([personId,row])=>({personId,text:row.text,bindingGeneration:row.bindingGeneration,operation:row.operation,unresolved:row.unresolved,notice:row.notice}))}));}catch{draftStorageUnavailable=true;}}
    function savedOperation(op,generation){return op&&typeof op.requestId==='string'&&/^[A-Za-z0-9._-]{1,160}$/.test(op.requestId)&&typeof op.text==='string'&&op.text.length<=2800&&op.bindingGeneration===generation&&['sending','pending','dispatching','failed','blocked','cancelled','expired','uncertain','unknown'].includes(op.status)?{requestId:op.requestId,text:op.text,bindingGeneration:op.bindingGeneration,status:op.status==='sending'?'unknown':op.status}:null;}
    function restoreMessageDrafts(){try{const raw=window.sessionStorage?.getItem(messageDraftKey);if(!raw)return;const saved=JSON.parse(raw);if(saved.ownerId!==ownerIdentity||!Array.isArray(saved.drafts)){window.sessionStorage?.removeItem(messageDraftKey);return;}for(const row of saved.drafts){if(!person(row.personId)||typeof row.text!=='string'||row.text.length>2800||!Number.isSafeInteger(row.bindingGeneration)||row.bindingGeneration<0)continue;const operation=savedOperation(row.operation,row.bindingGeneration),unresolved=Array.isArray(row.unresolved)?row.unresolved.slice(-100).map(op=>savedOperation(op,row.bindingGeneration)).filter(Boolean):[];messageDrafts.set(row.personId,{text:row.text,bindingGeneration:row.bindingGeneration,operation,unresolved,notice:operation?'上次提交结果待核对，未自动重发。':typeof row.notice==='string'?row.notice:''});}}catch{draftStorageUnavailable=true;}}
    function messageDraft(p){const generation=bindingGeneration(p);let row=messageDrafts.get(p.id);if(!row){row={text:'',bindingGeneration:generation,operation:null,unresolved:[],notice:''};messageDrafts.set(p.id,row);}else if(row.bindingGeneration!==generation){row={text:'',bindingGeneration:generation,operation:null,unresolved:[],notice:'微信绑定已更新，旧发送草稿已清除。'};messageDrafts.set(p.id,row);saveMessageDrafts();}return row;}
    function captureMessageFocus(){if(activeView==='family'&&historyScroll&&familyRoot?.contains(historyScroll)&&person(historyScrollPerson)){const local=historyState(historyScrollPerson);if(historyScroll.dataset.query===local.query){local.scrollTop=historyScroll.scrollTop;local.followLatest=historyScroll.scrollHeight-historyScroll.scrollTop-historyScroll.clientHeight<80;}}const field=document.activeElement;if(activeView==='family'&&field?.name==='owner-history-message'&&field.dataset.personId===historyPerson&&familyRoot?.contains(field))messageFocus={personId:historyPerson,bindingGeneration:Number(field.dataset.bindingGeneration),start:field.selectionStart,end:field.selectionEnd,direction:field.selectionDirection};}
    function applyMessageReceipt(id,operation,result,generation=ownerGeneration){const row=messageDrafts.get(id),p=person(id);if(generation!==ownerGeneration||!ownerIdentity||!p||row?.operation?.requestId!==operation.requestId||bindingGeneration(p)!==operation.bindingGeneration||row.bindingGeneration!==operation.bindingGeneration)return false;const status=result?.personId===id&&typeof result.outboxId==='string'?result.status:'unknown';if(status==='api_accepted'){if(row.text===operation.text)row.text='';row.operation=null;row.notice='微信接口已接收；实际收到或已读请由本人确认。';const local=historyState(id);local.query='';local.nextCursor=null;local.hasMore=false;local.loaded=false;local.dirty=true;local.scrollToLatest=true;}else{row.operation.status=['failed','blocked','cancelled','expired','pending','dispatching','uncertain'].includes(status)?status:'unknown';row.notice=['failed','blocked','cancelled','expired'].includes(row.operation.status)?'这条消息未完成发送，草稿已保留。':'发送结果待核对，未自动重发；草稿已保留。';}saveMessageDrafts();return true;}
    const messageUnavailable=p=>state().config?.paused?'服务已暂停，恢复连接后再发送。':!(p.binding?.connected||p.binding?.status==='connected')?'这位家人尚未连接微信。':!bindingGeneration(p)?'尚未核对当前微信绑定，请先恢复连接。':'';
    async function sendHistoryMessage(id){const p=person(id);if(!p||!ownerIdentity)return;const row=messageDraft(p);if(messageUnavailable(p)||row.operation?.status==='sending')return;
      if(row.operation&&['unknown','uncertain','pending','dispatching'].includes(row.operation.status)&&row.text.trim()&&row.text.trim()!==row.operation.text.trim()){if(row.unresolved.length>=100){row.notice='较早发送结果仍需核对，请先刷新核对后再发新消息。';drawFamily();return;}row.unresolved.push({...row.operation});row.operation=null;}
      if(row.operation&&['unknown','uncertain','pending','dispatching'].includes(row.operation.status)){const generation=ownerGeneration;try{await refresh();if(generation===ownerGeneration&&row.operation){row.notice='发送结果仍待核对，未自动重发；请核对微信或稍后刷新。';saveMessageDrafts();}}catch{if(generation===ownerGeneration)row.notice='暂时无法核对发送状态，未自动重发。';}if(historyPerson===id)drawFamily();return;}
      if(!row.text.trim())return;if(row.text.length>2800){row.notice='每条消息最多 2800 字，请缩短后发送。';drawFamily();return;}
      const operation={requestId:crypto.randomUUID(),text:row.text,bindingGeneration:bindingGeneration(p),status:'sending'},generation=ownerGeneration;row.operation=operation;row.notice=(row.unresolved.length?'上一条结果待核对，这次另发新消息。':'')+'正在提交给'+p.label+'的微信接口…';saveMessageDrafts();drawFamily();
      try{const result=await post({action:'owner_send_message',personId:id,text:operation.text,requestId:operation.requestId,bindingGeneration:operation.bindingGeneration});applyMessageReceipt(id,operation,result,generation);}
      catch{applyMessageReceipt(id,operation,{personId:id,status:'unknown'},generation);}
      if(generation===ownerGeneration&&person(id)&&bindingGeneration(person(id))===operation.bindingGeneration){if(historyPerson===id)drawFamily();try{await refresh();}catch{}if(historyPerson===id)drawFamily();}
    }
    function historyComposer(p){const row=messageDraft(p),form=el('form',null,'lele-history-composer'),label=el('label',null,'lele-history-compose-label'),field=el('textarea');label.append(el('span','发给'+p.label+' · 通过乐乐转达'));field.name='owner-history-message';field.rows=2;field.maxLength=2800;field.value=row.text;field.placeholder='给'+p.label+'发消息';field.dataset.personId=p.id;field.dataset.bindingGeneration=String(row.bindingGeneration);field.setAttribute('aria-label','发消息给'+p.label);label.append(field);form.append(label);form.setAttribute('aria-label','发消息给'+p.label);
      const footer=el('div',null,'lele-history-compose-actions'),hint=el('small','Enter 发送 · Shift+Enter 换行'),submit=el('button','','primary');submit.type='button';submit.addEventListener('click',event=>{if(event.detail>1)return;void sendHistoryMessage(p.id);});footer.append(hint,submit);form.append(footer);const status=el('p',null,'lele-history-send-status');status.setAttribute('role','status');status.setAttribute('aria-live','polite');form.append(status);
      const update=()=>{const unavailable=messageUnavailable(p),unknown=row.operation&&['unknown','uncertain','pending','dispatching'].includes(row.operation.status),newMessage=unknown&&row.text.trim()&&row.text.trim()!==row.operation.text.trim(),checking=unknown&&!newMessage,sending=row.operation?.status==='sending';submit.textContent=sending?'正在提交…':checking?'核对发送状态':newMessage?'发送新消息给'+p.label:row.operation?'重新发送':'发送给'+p.label;submit.disabled=Boolean(unavailable||sending||!checking&&!row.text.trim());status.textContent=unavailable||[(row.unresolved.length?'较早的 '+row.unresolved.length+' 条发送结果仍待核对。':''),row.notice||(draftStorageUnavailable?'浏览器暂不能保存草稿，请保持此页打开。':'')].filter(Boolean).join(' ');};update();if(messageUnavailable(p))form.append(button('恢复连接',()=>openPerson(p.id),'text-button'));
      field.addEventListener('compositionstart',()=>{row.composing=true;});field.addEventListener('compositionend',()=>{row.composing=false;});field.addEventListener('input',()=>{if(messageDrafts.get(p.id)!==row)return;row.text=field.value;saveMessageDrafts();update();});field.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229&&!row.composing){event.preventDefault();if(!event.repeat)void sendHistoryMessage(p.id);}});form.addEventListener('submit',event=>{event.preventDefault();void sendHistoryMessage(p.id);});
      if(messageFocus?.personId===p.id&&messageFocus.bindingGeneration===row.bindingGeneration){field.__leleRestoreFocus=messageFocus;}return form;
    }
    let cachedTools=null,cachedAssignments=null,cachedRequests=null,cachedProjects=null,cachedPolicies=null,loadingTools=false,loadingHarness=false;
    const lock=(b,value)=>{b.disabled=value;if(value)pendingButtons.add(b);else pendingButtons.delete(b);};
    const error=(target,value)=>{target.textContent=value;target.hidden=!value;};
    function syncDisabled(){for(const b of pendingButtons){if(b.isConnected===false)pendingButtons.delete(b);else b.disabled=true;}}
    const dialog=title=>{++dialogVersion;return openDialog(title);};
    function formLayout(form,footer){const scroll=el('div',null,'lele-form-scroll'),children=[...form.children].filter(child=>child!==footer);form.replaceChildren(scroll,footer);scroll.append(...children);form.className=(form.className||'')+' lele-config-form';}
    function rowsState(parent,title,description){const s=el('div',null,'lele-empty');s.append(el('h2',title),el('p',description));parent.append(s);}
    async function post(body){return request(body);}
    function historyState(id){if(!histories.has(id))histories.set(id,{query:'',messages:[],total:null,nextCursor:null,hasMore:false,loading:false,error:'',access:null,loaded:false,source:null,anchor:historyAnchor(person(id)),dirty:false,scrollTop:0,followLatest:true});return histories.get(id);}
    async function loadHistory({older=false}={}){
      const id=historyPerson,p=person(id);if(!p||!ownerIdentity)return;const local=historyState(id);if(local.loading)return;
      const version=++historyVersion,query=local.query;local.loading=true;local.dirty=false;local.error='';drawFamily();
      try{
        const page=await post({action:'history_page',personId:id,limit:50,...(query?{query}:{}),...(older&&local.nextCursor?{before:local.nextCursor}:{})});
        if(version!==historyVersion||historyPerson!==id||local.query!==query)return;
        // An Owner identity change or removed member invalidates in-flight data.
        if(!ownerIdentity||!person(id)){Object.assign(local,{access:null,messages:[],total:null,hasMore:false,nextCursor:null,loaded:true});}
        else Object.assign(local,{access:page.access,messages:page.access==='full'?(older?[...(page.messages||[]),...local.messages]:(page.messages||[])):[],total:page.access==='full'?page.total:null,hasMore:page.access==='full'&&Boolean(page.hasMore),nextCursor:page.nextCursor,source:page.source,loaded:true});
      }catch(e){if(version===historyVersion)local.error=e.message;}
      finally{if(version===historyVersion){local.loading=false;drawFamily();}}
    }
    function openHistory(id){if(!person(id))return;if(historyPerson!==id)messageFocus=null;historyPerson=id;historyMobile='detail';++historyVersion;const local=historyState(id);local.loading=false;drawFamily();if(!local.loaded)void loadHistory();}
    function renderFamily(root){familyRoot=root;drawFamily();}
    function drawFamily(){
      if(!familyRoot||activeView!=='family')return;captureMessageFocus();familyRoot.replaceChildren();
      if(!people().length){rowsState(familyRoot,'还没有家人资料','先设置你自己，再介绍一位家人。');familyRoot.append(button('添加家人',addFamily,'primary'));return;}
      if(!ownerIdentity){rowsState(familyRoot,'请先登记 Owner','登记后可查看本机保存的家庭对话。');return;}
      if(!person(historyPerson))historyPerson=people().find(p=>p.role!=='owner')?.id||people()[0].id;
      const shell=el('div',null,'lele-history-shell');shell.dataset.mobileView=historyMobile;
      const list=el('aside',null,'lele-history-members');list.append(el('h2','选择家人'));
      for(const p of people()){
        const b=button('',()=>openHistory(p.id),'lele-person-row');b.dataset.personId=p.id;b.setAttribute('aria-current',String(p.id===historyPerson));
        b.append(el('span',p.label?.slice(0,1)||'家','lele-person-avatar'),el('strong',p.label),el('small',p.binding?.connected?'已连接':'未连接'));list.append(b);
      }
      list.append(button('添加家人',addFamily,'text-button'));note(list,'家人之间独立聊天；Owner 可查看本机保存的全部对话。');
      const detail=el('section',null,'lele-history-detail'),p=person(historyPerson),local=historyState(p.id);
      const head=el('header',null,'lele-history-header'),heading=el('div');
      const back=button('返回家人列表',()=>{historyMobile='list';drawFamily();},'text-button lele-history-back');heading.append(el('h2',p.label+'与乐乐的对话'),el('p','本机保存的双方原文，供 Owner 查看','hint'));
      head.append(back,heading,button('资料与连接',()=>openPerson(p.id),'text-button'));detail.append(head);const body=el('div',null,'lele-history-scroll');body.dataset.query=local.query;
      {
        const search=el('form',null,'lele-history-search'),query=input('history-query','search',local.query);query.placeholder='查找这位家人的原话';query.maxLength=200;
        const searchButton=button('查找',()=>{local.query=query.value.trim();local.loaded=false;local.messages=[];local.nextCursor=null;local.scrollTop=0;local.followLatest=false;local.scrollToLatest=false;void loadHistory();});
        search.append(query,searchButton);search.addEventListener('submit',event=>{event.preventDefault();searchButton.click?searchButton.click():searchButton.dispatchEvent(new Event('click'));});body.append(search);
        if(local.error){const alert=el('p',local.error,'error');alert.setAttribute('role','alert');body.append(alert,button('重新读取',()=>loadHistory()));}
        if(local.loading)note(body,'正在读取对话…');
        if(local.loaded&&!local.loading&&local.total===0)rowsState(body,local.query?'没有找到这句话':'尚无已保存的对话',local.query?'搜索覆盖这位家人的全部可见本机记录，试试其他词。':'来信与接口已接受的回复会保存在这里。');
        if(local.messages.length){
          note(body,`${local.query?'匹配':'已加载'} ${local.messages.length} 条${Number.isInteger(local.total)?`，共 ${local.total} 条`:''}`,'lele-history-count');
          const transcript=el('div',null,'lele-history-transcript');transcript.setAttribute('role','log');transcript.setAttribute('aria-label',p.label+'与乐乐的对话原文');
          for(const message of local.messages){const article=el('article',null,'lele-history-message '+(message.dir==='in'?'from-person':message.kind==='owner_message'?'from-owner':'from-lele')),header=el('header');header.append(el('strong',message.kind==='owner_message'?'你 · 通过乐乐':message.dir==='in'?p.label:'乐乐'),el('time',time(message.at)));article.append(header,el('p',message.text));
            for(const file of message.attachments||[]){const fileRow=el('div',null,'lele-history-file');fileRow.append(el('strong',file.name||'文件'),el('small',[file.mimeType,Number.isFinite(file.size)?Math.ceil(file.size/1024)+' KB':''].filter(Boolean).join('，')));article.append(fileRow);}transcript.append(article);}
          body.append(transcript);
        }
        if(local.hasMore)body.append(button(local.loading?'正在读取…':'查看更早记录',()=>loadHistory({older:true})));
        else if(local.loaded&&local.messages.length)note(body,'已显示全部匹配记录。');
        note(body,'这里是本机现存归档，接口已接受不代表手机收到或已读。','lele-source-note');
      }
      const actions=el('div',null,'lele-detail-actions');actions.append(button('补充资料',()=>editPerson(p.id)),button('项目权限',()=>openPermissions(p.id)),button('配置工具',()=>{toolPerson=p.id;showToolsDialog(p.id);}));body.append(actions);const composer=historyComposer(p);detail.append(body,composer);
      shell.append(list,detail);familyRoot.append(shell);familyRoot.dataset.mobileView=historyMobile;const field=composer.children[0].children[1],focus=field.__leleRestoreFocus;if(focus&&(historyMobile==='detail'||window.matchMedia?.('(max-width:760px)')?.matches!==true)){field.focus({preventScroll:true});if(Number.isInteger(focus.start)&&Number.isInteger(focus.end))field.setSelectionRange?.(focus.start,focus.end,focus.direction||'none');}body.scrollTop=!local.query&&(local.scrollToLatest||local.followLatest)?body.scrollHeight:local.scrollTop;historyScroll=body;historyScrollPerson=p.id;if(local.scrollToLatest&&local.loaded&&!local.loading){local.scrollToLatest=false;local.followLatest=true;}if((!local.loaded||local.dirty)&&!local.loading&&!local.error)void loadHistory();
    }
    async function loadTools(force=false){
      if(loadingTools)return;if(cachedTools&&!force){drawTools();return;}loadingTools=true;drawTools();const generation=ownerGeneration;
      try{const values=await Promise.all([post({action:'tool_catalog'}),post({action:'tool_assignments'}),post({action:'workflow_requests'})]);if(generation!==ownerGeneration)return;cachedTools=items(values[0]);cachedAssignments=items(values[1]);cachedRequests=items(values[2]);}
      catch(e){onError(e.message);cachedTools=null;}
      finally{loadingTools=false;drawTools();}
    }
    function renderTools(root){toolRoot=root;drawTools();if(!cachedTools)void loadTools();}
    function toolStatus(row){if(!row.executorAvailable)return'执行服务尚未就绪';if(!row.ready&&row.reason==='not_assigned')return'选择家人后配置';return'资料源将在调用时核对';}
    function drawTools(){
      if(!toolRoot||activeView!=='tools')return;toolRoot.replaceChildren();if(!people().some(p=>p.role==='owner')){rowsState(toolRoot,'先设置家庭安排人','设置你自己后，再为家人配置工具。');return;}note(toolRoot,'家人可以直接在微信提出需求，乐乐会在本人的独立工作区处理。这里预设常用快捷服务；本地项目和私人资料另行授权。','lele-source-note');
      if(loadingTools&&!cachedTools)note(toolRoot,'正在读取工具…');
      if(!cachedTools&&!loadingTools){toolRoot.append(button('重新读取工具',()=>loadTools(true)));return;}
      for(const row of cachedTools||[]){const info=tools[row.toolId]||{title:row.title,description:row.description},article=el('article',null,'lele-tool-row'),copy=el('div');copy.append(el('h2',info.title),el('p',info.description),el('small',toolStatus(row)));article.append(copy,button('给家人开通',()=>openTool(row.toolId,toolPerson)));toolRoot.append(article);}
      const assigned=(cachedAssignments||[]).filter(row=>!toolPerson||row.personId===toolPerson);toolRoot.append(el('h2','已预设的快捷服务','lele-section-heading'));
      if(!assigned.length)note(toolRoot,'选择一个工具，再决定给谁用、怎么调用或投送。');
      for(const grant of assigned){const p=person(grant.personId);if(!p)continue;const row=el('article',null,'lele-tool-row'),copy=el('div');copy.append(el('h3',p.label+'的'+(tools[grant.toolId]?.title||grant.toolId)));note(copy,[grant.allowInvoke?'本人可主动调用':'本人主动调用已关闭',grant.schedule?.enabled?`定时 ${grant.schedule.time}（${grant.schedule.timeZone}）`:'未设定时投送'].join('；'));const service=(cachedTools||[]).find(t=>t.toolId===grant.toolId);note(copy,!p.binding?.connected?'等待本人连接，尚未运行':!service?.executorAvailable?'执行服务尚未就绪':'安排已保存，资料源将在调用时核对');row.append(copy,button('查看或修改',()=>openTool(grant.toolId,p.id)));toolRoot.append(row);}
      toolRoot.append(el('h2','家人想要的新工具','lele-section-heading'));
      if(!(cachedRequests||[]).length)note(toolRoot,'家人明确申请的工具需求会出现在这里。');
      for(const item of cachedRequests||[]){const p=person(item.personId),row=el('article',null,'lele-tool-row'),copy=el('div');copy.append(el('h3',(p?.label||'家人')+'的需求'),el('p',item.text));note(copy,({pending:'待你处理',accepted:'正在接续',completed:'已标记完成',declined:'暂不制作'})[item.status]||item.status);row.append(copy,button('查看并接续',()=>openWorkflow(item)));toolRoot.append(row);}
      toolRoot.append(button('刷新工具与需求',()=>loadTools(true),'text-button'));
    }
    function showToolsDialog(id){toolPerson=id;const body=dialog('为'+(person(id)?.label||'家人')+'配置工具');for(const [toolId,info]of Object.entries(tools))body.append(button(info.title,()=>openTool(toolId,id)));}
    async function projects(){if(!cachedProjects){const generation=ownerGeneration,rows=items(await post({action:'harness_projects'}));if(generation!==ownerGeneration)throw new Error('家庭安排人已改变，请重新读取项目。');cachedProjects=rows;}return cachedProjects;}
    async function openTool(toolId,personId){
      const info=tools[toolId];if(!info)return;const body=dialog(info.title),version=dialogVersion;note(body,'正在读取配置…');
      try{
        const assignments=items(await post({action:'tool_assignments'}));if(version!==dialogVersion)return;cachedAssignments=assignments;const projectRows=toolId==='ai_digest'?await projects():[];if(version!==dialogVersion)return;
        body.replaceChildren();const form=el('form',null,'lele-tool-form'),members=people().filter(p=>p.role!=='owner'),available=members.length?members:people();if(!available.length){rowsState(body,'先添加一位家人','添加资料并由本人连接微信后，即可开始使用工具。');return;}
        const chosen=personId&&available.some(p=>p.id===personId)?personId:available[0].id;
        let grant=(cachedAssignments||[]).find(g=>g.personId===chosen&&g.toolId===toolId);
        const recipient=field(form,'给谁使用',select('personId',available.map(p=>({value:p.id,label:p.label})),chosen));
        const resource=el('div',null,'lele-tool-resource');form.append(resource);let projectInput,pathInput,sourceAdvanced,latestDigest,sourceTimeZone,cityInput,locationInput,locations=[],selectedLocation=grant?.resource?.locationId||null;
        function populateResource(){resource.replaceChildren();const old=(cachedAssignments||[]).find(g=>g.personId===recipient.value&&g.toolId===toolId);grant=old;
          if(toolId==='ai_digest'){
            projectInput=field(resource,'日报所在项目',select('workspaceId',projectRows.map(row=>({value:row.workspaceId,label:row.title})),old?.resource?.workspaceId));
            const sourceArea=el('div');resource.append(sourceArea);sourceAdvanced=el('details');sourceAdvanced.append(el('summary','手动指定文件'));
            pathInput=field(sourceAdvanced,'项目内的相对路径',input('relativePath','text',old?.resource?.relativePath||''));pathInput.placeholder='例如：reports/latest.md';resource.append(sourceAdvanced);latestDigest=input('latestDigest','checkbox');latestDigest.checked=old?.resource?.selection==='latest';field(resource,'每天取同一来源最新已生成的日报',latestDigest);const sourceZone=el('div');sourceTimeZone=field(sourceZone,'日报日期所在时区',input('sourceTimeZone','text',old?.resource?.sourceTimeZone||people().find(p=>p.role==='owner')?.timeZone||state().config?.timeZone||'America/Mexico_City'));sourceZone.hidden=!latestDigest.checked;latestDigest.addEventListener('change',()=>{sourceZone.hidden=!latestDigest.checked;});resource.append(sourceZone);note(resource,'只读取选定来源；当天还没生成就不发旧内容。收件时间另按家人时区。');
            const recipientId=recipient.value,sourcePath=pathInput,sourceProject=projectInput;let sourceGeneration=0;
            async function loadSources(){const generation=++sourceGeneration,workspaceId=sourceProject.value;sourceArea.replaceChildren();if(!workspaceId){note(sourceArea,'尚未找到项目，请先在 Harness 添加日报项目。');sourceAdvanced.open=true;return;}note(sourceArea,'正在读取可用的日报文件…');
              try{const files=items(await post({action:'digest_sources',workspaceId}));if(version!==dialogVersion||recipient.value!==recipientId||sourceProject.value!==workspaceId||generation!==sourceGeneration)return;
                sourceArea.replaceChildren();const picker=field(sourceArea,'选择现有日报文件',select('digestFile',[{value:'',label:files.length?'请选择日报文件':'没有找到安全文本文件'},...files.map(file=>({value:file.relativePath,label:file.relativePath}))],sourcePath.value));
                if(!sourcePath.value&&files.length===1){sourcePath.value=files[0].relativePath;picker.value=files[0].relativePath;}
                picker.addEventListener('change',()=>{sourcePath.value=picker.value;});sourcePath.addEventListener('input',()=>{picker.value=files.some(file=>file.relativePath===sourcePath.value)?sourcePath.value:'';});
                if(!files.length){note(sourceArea,'项目里还没有可选择的文本日报，可以稍后刷新，或手动指定已有文件。');sourceAdvanced.open=true;}
                sourceArea.append(button('刷新文件列表',()=>loadSources(),'text-button'));
              }catch(e){if(version!==dialogVersion||recipient.value!==recipientId)return;sourceArea.replaceChildren();note(sourceArea,'暂未读到文件列表，可刷新或手动指定已有文件。');sourceArea.append(button('重新读取文件',()=>loadSources(),'text-button'));sourceAdvanced.open=true;}
            }
            sourceProject.addEventListener('change',()=>{sourcePath.value='';void loadSources();});void loadSources();
          }else if(toolId==='weather'){
            cityInput=field(resource,'家人所在城市',input('city','text',old?.resource?.city||''));cityInput.placeholder='例如：杭州';selectedLocation=old?.resource?.locationId||null;locationInput=null;locations=[];
            const find=button('查找城市',async b=>{if(!cityInput.value.trim())return;lock(b,true);try{locations=items(await post({action:'weather_locations',query:cityInput.value.trim()}));if(version!==dialogVersion)return;selectedLocation=null;
              if(locationInput)locationInput.remove();locationInput=select('locationId',locations.map(row=>({value:String(row.id),label:row.label||[row.name,row.admin1,row.country].filter(Boolean).join('，')})));locationInput.setAttribute('aria-label','选择准确城市');resource.append(locationInput);if(locations.length)selectedLocation=String(locations[0].id);else note(resource,'没有找到，请补充省份或国家再查。');locationInput.addEventListener('change',()=>{selectedLocation=locationInput.value;});
            }catch(e){error(alert,e.message);}finally{lock(b,false);}});resource.append(find);note(resource,'同名城市请选准确位置，避免推送了另一个地方的天气。');
            cityInput.addEventListener('input',()=>{selectedLocation=null;if(locationInput){locationInput.remove();locationInput=null;}});
          }else note(resource,'开通后家人可以在微信发送要求及文字材料。定时投送只邀请提交材料，收到后才制作 PPT。');
        }
        populateResource();
        const invoke=input('allowInvoke','checkbox');invoke.checked=grant?.allowInvoke??true;field(form,toolId==='presentation'?'允许本人提交材料和继续修改':'允许家人在微信主动调用',invoke);
        const scheduled=input('scheduled','checkbox');scheduled.checked=Boolean(grant?.schedule?.enabled);field(form,toolId==='presentation'?'定时邀请家人提交材料':'定时主动投送',scheduled);
        const scheduleFields=el('div',null,'lele-schedule-fields'),at=field(scheduleFields,'当地时间',input('time','time',grant?.schedule?.time||'')),zone=field(scheduleFields,'使用哪个时区',input('timeZone','text',grant?.schedule?.timeZone||person(chosen)?.timeZone||''));zone.setAttribute('list','time-zones');scheduleFields.hidden=!scheduled.checked;form.append(scheduleFields);const syncSchedule=()=>{scheduleFields.hidden=!scheduled.checked;if(toolId==='presentation'&&scheduled.checked)invoke.checked=true;invoke.disabled=toolId==='presentation'&&scheduled.checked;};scheduled.addEventListener('change',syncSchedule);syncSchedule();
        recipient.addEventListener('change',()=>{populateResource();invoke.checked=grant?.allowInvoke??true;scheduled.checked=Boolean(grant?.schedule?.enabled);at.value=grant?.schedule?.time||'';zone.value=grant?.schedule?.timeZone||person(recipient.value)?.timeZone||'';syncSchedule();});
        const alert=el('p',null,'inline-error');alert.hidden=true;alert.setAttribute('role','alert');const footer=el('div',null,'lele-dialog-actions'),save=button('保存安排',()=>{} ,'primary');save.type='submit';footer.append(button('取消',closeDialog,'text-button'),save);form.append(alert,footer);
        let saving=false;
        form.addEventListener('submit',async event=>{event.preventDefault();if(saving)return;error(alert,'');
          let resourceValue;
          if(toolId==='ai_digest'){if(!projectInput.value||!pathInput.value.trim()){if(sourceAdvanced)sourceAdvanced.open=true;return error(alert,'请选择项目和一份日报文件。');}resourceValue={workspaceId:projectInput.value,relativePath:pathInput.value.trim(),...(latestDigest.checked?{selection:'latest',sourceTimeZone:sourceTimeZone.value.trim()}:{})};}
          else if(toolId==='weather'){if(!selectedLocation)return error(alert,'请先查找并选择准确城市。');const location=locations.find(row=>String(row.id)===String(selectedLocation));resourceValue={city:location?.label||cityInput.value.trim(),locationId:Number(selectedLocation)};}
          else resourceValue={workflow:'presentation'};
          if(scheduled.checked){if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(at.value)||!zone.value.trim())return error(alert,'请填写投送时间和时区。');try{new Intl.DateTimeFormat('en',{timeZone:zone.value.trim()});}catch{return error(alert,'这个时区无法识别，请使用例如 Asia/Shanghai。');}}
          saving=true;lock(save,true);
          try{const saved=await post({action:'tool_assign',personId:recipient.value,toolId,resource:resourceValue,allowInvoke:invoke.checked,schedule:scheduled.checked?{enabled:true,time:at.value,timeZone:zone.value.trim()}:null});cachedAssignments=[...(cachedAssignments||[]).filter(row=>row.personId!==saved.personId||row.toolId!==saved.toolId),saved];await refresh();drawTools();if(version!==dialogVersion)return;const target=person(recipient.value),invokeRequestId='console-tool-'+crypto.randomUUID();body.replaceChildren();rowsState(body,!invoke.checked&&!scheduled.checked?'工具已停用':'安排已保存',!invoke.checked&&!scheduled.checked?'这位家人的主动调用和定时投送均已关闭。':!target?.binding?.connected?'等待本人连接微信后才会运行。':'工具会按配置调用，真实资料源将在运行时检查。');body.append(button('完成',()=>{closeDialog();void loadTools(true);},'primary'),button(toolId==='presentation'?'提醒'+(target?.label||'家人')+'发材料':'现在发给'+(target?.label||'家人'),async b=>{lock(b,true);try{const result=await post({action:'tool_invoke',personId:recipient.value,toolId,requestId:invokeRequestId});if(version!==dialogVersion)return;note(body,result.deliveryStatus==='api_accepted'?'结果已交给微信接口，手机实际收到仍待本人确认。':result.status==='succeeded'?'工具已完成，请核对投递状态。':'这次工具尚未完成，请检查资料源、服务运行状态或连接。');}catch(e){if(version===dialogVersion)note(body,e.message,'error');}finally{lock(b,false);}}));}
          catch(e){if(version===dialogVersion)error(alert,e.message);}finally{saving=false;lock(save,false);}
        });formLayout(form,footer);body.append(form);
      }catch(e){if(version===dialogVersion){body.replaceChildren();rowsState(body,'暂未读到配置',e.message);body.append(button('重新读取',()=>openTool(toolId,personId)));}}
    }
    function openWorkflow(item){
      const body=dialog((person(item.personId)?.label||'家人')+'的工具需求'),version=dialogVersion;body.append(el('p',item.text,'lele-quote'));
      const form=el('form'),status=field(form,'如何接续',select('status',[{value:'pending',label:'待处理'},{value:'accepted',label:'正在接续'},{value:'completed',label:'已完成'},{value:'declined',label:'暂不制作'}],item.status));
      const message=el('textarea');message.name='note';message.value=item.note||'';message.rows=3;message.maxLength=2000;field(form,'处理说明',message);note(form,'填写的说明会转达给这位家人；只改状态不会发送消息，也不会自动创建或开通工具。');
      const alert=el('p',null,'error');alert.hidden=true;const save=button('保存并转达说明',()=>{},'primary');save.type='submit';form.append(alert,save);let saving=false;const operationId='workflow-console-'+crypto.randomUUID();
      form.addEventListener('submit',async e=>{e.preventDefault();if(saving)return;saving=true;lock(save,true);try{const saved=await post({action:'workflow_request_update',personId:item.personId,requestId:item.requestId,status:status.value,operationId,...(message.value.trim()?{note:message.value.trim()}:{})});cachedRequests=(cachedRequests||[]).map(row=>row.personId===saved.personId&&row.requestId===saved.requestId?saved:row);drawTools();if(version===dialogVersion){if(message.value.trim()){const result=el('p',saved.notification?.reply||(saved.notification?.status==='api_accepted'?'说明已交给微信接口；实际收信待本人确认。':'说明已保存，微信投递尚未确认。'),'hint');result.setAttribute('role','status');form.append(result);save.disabled=true;}else closeDialog();void loadTools(true);}}catch(err){error(alert,err.message);}finally{saving=false;lock(save,false);}});body.append(form);
    }
    async function loadHarness(force=false){if(loadingHarness)return;if(cachedProjects&&cachedPolicies&&!force){drawHarness();return;}loadingHarness=true;drawHarness();const generation=ownerGeneration;try{const value=await Promise.all([post({action:'harness_projects'}),post({action:'family_access_list'})]);if(generation!==ownerGeneration)return;cachedProjects=items(value[0]);cachedPolicies=items(value[1]);}catch(e){onError(e.message);}finally{loadingHarness=false;drawHarness();}}
    function renderHarness(root){harnessRoot=root;drawHarness();if(!cachedProjects||!cachedPolicies)void loadHarness();}
    function drawHarness(){
      if(!harnessRoot||activeView!=='arrangements')return;harnessRoot.replaceChildren();if(!people().some(p=>p.role==='owner')){rowsState(harnessRoot,'先设置家庭安排人','你自己的身份确认后，再读取项目或分配权限。');return;}note(harnessRoot,'家人默认在自己的工作区办事；下面可额外共享选定的本地项目。Owner 保留原有项目能力。','lele-source-note');
      if(loadingHarness)note(harnessRoot,'正在读取项目与权限…');
      if(!cachedProjects&&!loadingHarness)harnessRoot.append(button('重新读取项目',()=>loadHarness(true)));
      for(const project of cachedProjects||[]){const row=el('article',null,'lele-tool-row'),copy=el('div');copy.append(el('h2',project.title||project.workspaceId),el('p',project.path||'已登记的本地项目','hint'));row.append(copy,button('交代一件事',()=>openDispatch(project)));harnessRoot.append(row);}
      const members=people().filter(p=>p.role!=='owner');harnessRoot.append(el('h2','家人的项目权限','lele-section-heading'));
      for(const p of members){const policy=(cachedPolicies||[]).find(row=>row.personId===p.id),row=el('div',null,'lele-tool-row'),copy=el('div');copy.append(el('h3',p.label));note(copy,policy?.workspaceIds?.length?policy.workspaceIds.map(id=>(cachedProjects||[]).find(project=>project.workspaceId===id)?.title||id).join('、'):'个人工作区可用，尚未额外共享本地项目');row.append(copy,button('编辑权限',()=>openPermissions(p.id)));harnessRoot.append(row);}
      note(harnessRoot,state().harness?.familyExecution==='protected_executor_required'?'家人的个人工作区可以直接办事；本地项目仍需按范围授权。':'家人可以直接生成与修改本人文稿；本地项目按额外授予的资料和操作范围处理。');
      harnessRoot.append(el('h2','项目任务与结果','lele-section-heading'));
      const tasks=state().harness?.tasks||[];if(!tasks.length)note(harnessRoot,'还没有通过乐乐派发的项目任务。');
      for(const task of tasks.slice().reverse()){
        const article=el('article',null,'lele-native-task'),head=el('div',null,'lele-task-head');head.append(el('h3',(task.workspaceTitle||'项目任务')+(task.executor==='family_project'?'（受控项目任务）':'')),el('span',labels[task.state]||'状态待核对','state-pill'));article.append(head);if(task.contentAccess==='not_shared')note(article,'这位家人没有开放任务原文，只展示服务状态。');else if(task.prompt)article.append(el('p',task.prompt,'lele-task-prompt'));if(task.text)article.append(el('p',task.text,'lele-native-result'));if(task.notice)note(article,task.notice);if(task.deliveryTarget){const target=person(task.deliveryTarget.personId);note(article,'成果交给'+(target?.label||task.deliveryTarget.label||'指定家人')+' · '+({none:'等待任务结果',dispatching:'正在提交',accepted:'微信接口已接受，实收待确认',failed:'微信接口拒绝，未重发',unknown:'投递待核对，未重发',suppressed:'绑定或授权变化，已停止'}[task.delivery?.state]||'状态待核对'));}
        if(task.contentAccess!=='not_shared')for(const file of task.files||[])article.append(button('下载 '+(file.name||'文稿'),b=>downloadArtifact(task,file,b),'text-button'));
        const actions=el('div',null,'lele-detail-actions');actions.append(button('核对状态',async b=>{lock(b,true);try{await post({action:'harness_task_status',taskId:task.id});await refresh();}catch(e){note(article,e.message,'error');}finally{lock(b,false);}}));
        if(task.executor!=='family_project'&&['needs_approval','needs_input','running','queued','unknown'].includes(task.state))actions.append(button('打开官方会话',()=>openNativeSession(task),'text-button'));
        if(task.executor==='family_project'&&['queued','running','needs_input','needs_approval'].includes(task.state))actions.append(button('取消任务',async b=>{lock(b,true);try{const result=await post({action:'harness_cancel',taskId:task.id});await refresh();if(result.requiresNativeSession)await openNativeSession(task);}catch(e){onError(e.message);}finally{lock(b,false);}},'text-button'));
        if(task.executor!=='family_project'&&['queued','running','needs_input','needs_approval'].includes(task.state))actions.append(button('在官方会话取消',async()=>{await post({action:'harness_cancel',taskId:task.id});await openNativeSession(task);},'text-button'));
        if(task.personId===ownerIdentity&&task.origin==='console'&&['succeeded','failed','cancelled','needs_input'].includes(task.state)){
          const continuation=el('details'),summary=el('summary','继续这件事'),form=el('form'),text=el('textarea');text.rows=2;text.maxLength=4000;text.placeholder='补充要求，或继续修改这份结果';field(form,'接着说',text);const send=button('继续处理',()=>{},'primary');send.type='submit';const alert=el('p',null,'error');alert.hidden=true;form.append(alert,send);let pending=false,requestId=null,original='';
          form.addEventListener('submit',async event=>{event.preventDefault();if(pending||!text.value.trim())return;if(original!==text.value.trim()){original=text.value.trim();requestId='console-continue-'+crypto.randomUUID();}pending=true;lock(send,true);try{await post({action:'harness_continue',taskId:task.id,text:original,requestId});await refresh();}catch(e){error(alert,e.message);}finally{pending=false;lock(send,false);}});continuation.append(summary,form);article.append(continuation);
        }
        if(!task.deliveryTarget&&task.delivery?.state==='accepted')note(article,task.origin==='console'?'结果已回到当前控制台。':'结果已交给微信接口，手机收到仍待本人确认。');else if(!task.deliveryTarget&&task.delivery?.state==='unknown')note(article,task.origin==='console'?'控制台回传状态待核对，没有重新派发。':'结果投递状态不明，没有自动重发。');article.append(actions);harnessRoot.append(article);
      }
      harnessRoot.append(button('刷新项目与权限',()=>loadHarness(true),'text-button'));
    }
    async function downloadArtifact(task,file,button){
      const identity=ownerIdentity;lock(button,true);
      try{const result=await post({action:'harness_artifact',taskId:task.id,relativePath:file.relativePath});
        if(!ownerIdentity||identity!==ownerIdentity||!person(task.personId))throw new Error('Owner 身份或成员资料已改变，未下载。');
        if(typeof result.dataBase64!=='string'||result.dataBase64.length>13981020||!Number.isSafeInteger(result.bytes)||result.bytes<0||result.bytes>10485760)throw new Error('返回的文稿格式不正确。');
        const binary=atob(result.dataBase64),bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));if(bytes.length!==result.bytes)throw new Error('文稿长度校验未通过。');
        const blob=new Blob([bytes],{type:result.mimeType||'text/plain'}),url=URL.createObjectURL(blob),anchor=el('a');anchor.href=url;anchor.download=String(result.name||file.name||'文稿.txt').replace(/[\\/\x00-\x1f]/g,'_');document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
      }catch(e){onError(e.message);}finally{lock(button,false);}
    }
    function openDispatch(project){
      const body=dialog('交给'+(project.title||'这个项目')+'处理'),version=dialogVersion,form=el('form'),prompt=el('textarea');prompt.rows=4;prompt.maxLength=4000;prompt.required=true;prompt.placeholder='希望乐乐用这些资料做什么？';field(form,'交代一件事',prompt);
      const recipient=field(form,'完成后交给谁',select('recipientPersonId',[{value:'',label:'先返回给我'},...people().filter(p=>p.role!=='owner'&&(p.binding?.connected||p.binding?.status==='connected')).map(p=>({value:p.id,label:p.label+'的微信'}))],''));note(form,'由你授权 Harness 执行；指定家人只接收成果，不因此获得项目权限。');const alert=el('p',null,'error');alert.hidden=true;
      const submit=button('派发任务',()=>{},'primary');submit.type='submit';const footer=el('div',null,'lele-dialog-actions');footer.append(button('在主对话里说',()=>{closeDialog();chooseProject(project);},'text-button'),submit);form.append(alert,footer);let sending=false,requestId='console-native-'+crypto.randomUUID();
      form.addEventListener('submit',async e=>{e.preventDefault();if(sending||!prompt.value.trim())return;sending=true;lock(submit,true);try{await post({action:'harness_submit',workspaceId:project.workspaceId,text:prompt.value.trim(),requestId,...(recipient.value?{recipientPersonId:recipient.value}:{})});await refresh();if(version===dialogVersion){body.replaceChildren();rowsState(body,'任务已登记',recipient.value?'完成后会交给'+(person(recipient.value)?.label||'指定家人')+'；投递状态会返回这里。':'任务正在交给 Harness。审批或补充信息请在官方会话处理。');body.append(button('查看任务',closeDialog,'primary'));}}catch(err){if(version===dialogVersion)error(alert,err.message);}finally{sending=false;lock(submit,false);}});formLayout(form,footer);body.append(form);prompt.focus();
    }
    async function openPermissions(personId){
      const p=person(personId);if(!p||p.role==='owner')return;const body=dialog(p.label+'能让乐乐做什么'),version=dialogVersion;note(body,'正在读取已保存权限…');
      try{const values=await Promise.all([projects(),post({action:'family_access_list'})]);if(version!==dialogVersion)return;cachedPolicies=items(values[1]);const current=cachedPolicies.find(row=>row.personId===personId)||{workspaceIds:[],capabilities:[]};body.replaceChildren();const form=el('form'),projectChoices=[],capabilityChoices=[];
        const projectGroup=el('fieldset');projectGroup.append(el('legend','可使用的项目'));for(const project of values[0]){const check=input('workspaceId','checkbox');check.value=project.workspaceId;check.checked=current.workspaceIds.includes(project.workspaceId);field(projectGroup,project.title||project.workspaceId,check);projectChoices.push(check);}form.append(projectGroup);
        const capabilityGroup=el('fieldset');capabilityGroup.append(el('legend','在这些项目里能做什么'));for(const [id,label]of[['read','查看可用项目'],['task','读取资料与处理请求'],['write','生成专属项目文稿']]){const check=input('capability','checkbox');check.value=id;check.checked=current.capabilities.includes(id);field(capabilityGroup,label,check);capabilityChoices.push(check);}form.append(capabilityGroup);
        capabilityChoices.forEach((check,index)=>check.addEventListener('change',()=>{if(index===2&&check.checked){capabilityChoices[0].checked=true;capabilityChoices[1].checked=true;}if(index===1&&check.checked)capabilityChoices[0].checked=true;if(index===0&&!check.checked){capabilityChoices[1].checked=false;capabilityChoices[2].checked=false;}if(index===1&&!check.checked)capabilityChoices[2].checked=false;}));
        note(form,'文稿只保存到这位家人的成果目录，不修改项目原文件。项目权限与简报分享是独立设置；Owner 可查看已保存记录和成果。');note(form,state().harness?.familyExecution==='protected_executor_required'?'家人自由调用原生项目尚未开通；当前只会运行已分配的受控工具。':'家人使用受控项目工具，只能读取已授权项目；生成文稿需额外允许，不继承 Owner 的全部工具。');
        const alert=el('p',null,'error');alert.hidden=true;const save=button('保存权限',()=>{},'primary');save.type='submit';const footer=el('div',null,'lele-dialog-actions');footer.append(button('取消',closeDialog,'text-button'),save);form.append(alert,footer);let saving=false;
        form.addEventListener('submit',async e=>{e.preventDefault();if(saving)return;const workspaceIds=projectChoices.filter(input=>input.checked).map(input=>input.value),capabilities=capabilityChoices.filter(input=>input.checked).map(input=>input.value);if(capabilities.length&&!workspaceIds.length)return error(alert,'先选择至少一个项目，或取消所有操作以关闭项目权限。');saving=true;lock(save,true);try{const saved=await post({action:'family_access_grant',personId,workspaceIds,capabilities});cachedPolicies=[...(cachedPolicies||[]).filter(row=>row.personId!==personId),saved];drawHarness();if(version===dialogVersion){body.replaceChildren();rowsState(body,'权限已保存','工具和原生执行仍分别检查实际权限，不会继承 Owner 的全部能力。');body.append(button('完成',()=>{closeDialog();void loadHarness(true);},'primary'));}}catch(err){error(alert,err.message);}finally{saving=false;lock(save,false);}});formLayout(form,footer);body.append(form);
      }catch(e){if(version===dialogVersion){body.replaceChildren();rowsState(body,'尚未读到权限',e.message);body.append(button('重新读取',()=>openPermissions(personId)));}}
    }
    function invalidate(){cachedTools=null;cachedAssignments=null;cachedRequests=null;cachedProjects=null;cachedPolicies=null;}
    function onState(){captureMessageFocus();const next=people().find(p=>p.role==='owner')?.id||'';if(next!==ownerIdentity){if(ownerIdentity){closeDialog();try{window.sessionStorage?.removeItem(messageDraftKey);}catch{}}messageDrafts.clear();messageFocus=null;ownerIdentity=next;ownerGeneration++;historyVersion++;histories.clear();historyPerson='';toolPerson='';invalidate();if(next)restoreMessageDrafts();}
      let removed=false;for(const[id]of messageDrafts)if(!person(id)){messageDrafts.delete(id);removed=true;}if(removed)saveMessageDrafts();
      for(const[id,local]of histories){const p=person(id);if(!p){histories.delete(id);continue;}const anchor=historyAnchor(p);if(local.anchor!==anchor){const previous=JSON.parse(local.anchor);if(previous[0]!==bindingGeneration(p)&&historyPerson===id){historyVersion++;local.loading=false;}local.anchor=anchor;local.dirty=true;local.loaded=false;}}
      for(const[id]of messageDrafts){const p=person(id);if(!p)continue;const row=messageDraft(p),find=op=>(state().outbox||[]).find(item=>item.sourceKey==='owner-message:'+ownerIdentity+':'+op.requestId&&item.personId===id&&item.kind==='owner_message');const kept=row.unresolved.filter(op=>{const receipt=find(op);if(!receipt||!['api_accepted','failed','cancelled','blocked','expired'].includes(receipt.status))return true;if(receipt.status==='api_accepted'){const local=historyState(id);local.loaded=false;local.dirty=true;}return false;});if(kept.length!==row.unresolved.length){row.unresolved=kept;saveMessageDrafts();}const op=row.operation;if(!op)continue;const receipt=find(op);if(receipt&&receipt.status!==op.status)applyMessageReceipt(id,op,{...receipt,outboxId:receipt.id});}
    }
    function cancelDialog(){++dialogVersion;}
    return{setView:tab=>{if(tab!==activeView)messageFocus=null;activeView=tab;},renderFamily,renderTools,renderHarness,openHistory,openPermissions,openToolForMember:showToolsDialog,onState,cancelDialog,syncDisabled,invalidate};
  };
})();
