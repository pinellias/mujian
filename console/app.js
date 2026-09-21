/* ═════════════ 状态与元素 ═════════════ */
const editor=document.getElementById('editor');
const prevPane=document.getElementById('previewPane');
/* 触摸设备（手机/平板）：打开剧本、切回剧本时不主动抢焦点，避免一进来就弹软键盘。
   要打字用户自己点一下编辑区即可进入编辑态。桌面端不受影响。 */
const IS_TOUCH=('ontouchstart' in window)||(navigator.maxTouchPoints>0)||(window.matchMedia&&matchMedia('(pointer:coarse)').matches);
const show=name=>document.querySelectorAll('[data-state]').forEach(s=>
  s.classList.toggle('on', s.dataset.state===name));
document.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>{
  show(b.dataset.go);
  if(b.dataset.go==='data'){/* 回到编辑态时保持演示内容 */}else{closePop();closeFontPop();closeModals();}
});

/* ═════════════ 字数与行数统计（基于 md 源码） ═════════════ */
function stat(){
  const v=editor.value||'';
  const plain=v.replace(/!\[[^\]]*\]\([^)]*\)(?:\s*\{w=\d+\})?/g,'')   /* 图片地址不计入字数 */
    .replace(/^\s*#{1,6}\s+/gm,'').replace(/\*\*|__/g,'').replace(/^\s*>\s?/gm,'');
  document.getElementById('statChars').textContent=plain.replace(/\s+/g,'').length.toLocaleString();
  document.getElementById('statLines').textContent=v.split('\n').filter(l=>l.trim()).length;
  const n=(v.match(/^\s*###\s+\S/gm)||[]).length;
  document.getElementById('statScenes').textContent=n;
  const dm=document.getElementById('docMeta');
  if(dm)dm.textContent=' · 共 '+n+' 场';
}

/* ═════════════ 大纲：解析 md 源码中的 ### 场景行 ═════════════ */
/* 把光标定位到第 lineIdx 行：选中整行并滚动到可见处 */
function focusLine(lineIdx){
  const lines=editor.value.split('\n');
  let start=0;
  for(let i=0;i<lineIdx&&i<lines.length;i++)start+=lines[i].length+1;
  const end=start+(lines[lineIdx]||'').length;
  if(document.body.classList.contains('preview')){
    const el=prevPane.querySelector('[data-line="'+lineIdx+'"]');
    if(el){
      el.scrollIntoView({block:'center',behavior:'smooth'});
      el.style.outline='2px solid var(--accent)';
      setTimeout(()=>{el.style.outline='';},1400);
      return;
    }
    exitPreview();   /* 预览里找不到对应块时退回源码定位 */
  }
  editor.focus();
  editor.setSelectionRange(start,end);
  revealPos(start);
  editor.setSelectionRange(start,end);
}
function renderOutline(){
  const list=document.querySelector('.scene-list');
  if(!list)return;
  const lines=(editor.value||'').split('\n');
  const items=[];
  lines.forEach((ln,i)=>{
    const m=ln.match(/^\s*###\s+(.*\S)\s*$/);
    if(m)items.push({line:i,text:m[1]});
  });
  if(!items.length){
    if(!list.querySelector('[data-empty]')){
      list.innerHTML='';
      const d=document.createElement('div');
      d.dataset.empty='1';
      d.style.cssText='padding:16px 10px;font-size:12px;color:var(--ink-3);line-height:1.7';
      d.textContent='暂无场景';
      d.title='以 ### 开头的行会被识别为场景';
      list.appendChild(d);
    }
    return;
  }
  const empty=list.querySelector('[data-empty]');
  if(empty)empty.remove();
  const rowsArr=[...list.children].filter(r=>r.classList.contains('scene'));
  items.forEach((it,i)=>{
    const t=it.text;
    const tag=/内景/.test(t)?'内':(/外景/.test(t)?'外':'');
    const nm=t.replace(/^\s*\d+\s*/,'')||t;
    let s=rowsArr[i];
    if(!s){
      s=document.createElement('div');
      s.className='scene';
      s.innerHTML='<span class="no"></span><span class="nm"></span><span class="tag"></span>';
      list.appendChild(s);
    }
    s.onclick=()=>{
      document.querySelectorAll('.scene').forEach(x=>x.classList.remove('on'));
      s.classList.add('on');
      focusLine(it.line);
    };
    s.querySelector('.no').textContent='第 '+(i+1)+' 场';
    s.querySelector('.nm').textContent=nm;
    s.querySelector('.tag').textContent=tag;
  });
  for(let i=items.length;i<rowsArr.length;i++)rowsArr[i].remove();
  if(!list.querySelector('.scene.on')){const f=list.querySelector('.scene');if(f)f.classList.add('on');}
}

editor.addEventListener('input',()=>{autoGrow();stat();renderOutline();setUnsaved();scheduleHistory();});
/* Tab 缩进：源码模式下插入两个空格，而不是把焦点移出编辑区 */
editor.addEventListener('keydown',e=>{
  if(e.key==='Tab'&&!e.ctrlKey&&!e.metaKey&&!e.altKey){
    e.preventDefault();
    const s=editor.selectionStart,en=editor.selectionEnd,v=editor.value;
    editor.value=v.slice(0,s)+'  '+v.slice(en);
    editor.setSelectionRange(s+2,s+2);
    autoGrow();stat();renderOutline();setUnsaved();scheduleHistory();
  }
});
stat();

/* ═════════════ 文档清单 ═════════════ */
let DOC_ORDER=[];
let OPEN_TABS=[];
let DOC_VIEW={};                        /* 切走前记下的每篇滚动/光标位置，切回来还原 */
/* ── 分组：剧本可以归到组里，组永远排在未分组剧本前面 ──
   GDATA = { groups:[{id,name,open}], docs:{ 剧本名: 组id } } */
let GDATA={groups:[],docs:{},updated:null};
let selGroup=null;                       /* 仅用于高亮（新建组/右键组菜单时）；点击组本身=展开/收起，不再选中 */
const gidOf=n=>GDATA.docs[n]||'';
const docsInGroup=gid=>DOC_ORDER.filter(n=>gidOf(n)===gid);
const freeDocs=()=>DOC_ORDER.filter(n=>!gidOf(n));
/* ── 文档身份串：显示名 § id（§=U+001F）──
   文件按 id 存（data/<组文件夹?>/<id>.md），显示名存在 frontmatter 的 name 字段，
   因此不同组 / 未分组的剧本可以同名；对外一切以「身份串」为主键。
   下方 docName / docId 分别取显示名与 id（id 始终唯一，显示名可跨组重复）。 */
const DOC_SEP='\u001F';
function docId(s){if(!s)return '';const i=String(s).indexOf(DOC_SEP);return i<0?'':s.slice(i+1);}
function docName(s){if(!s)return '';const i=String(s).indexOf(DOC_SEP);return i<0?String(s):s.slice(0,i);}
function newDocId(){return 'd'+Date.now().toString(36)+Math.random().toString(36).slice(2,8);}
function docIdentity(display,id){return String(display)+DOC_SEP+String(id);}
/* 同组（含未分组）内是否已存在该显示名（排除自身 id）——改名 / 新建时拦「同组重名」，
   但允许不同组 / 未分组之间重名（这正是本次要修的点） */
function displayTakenInScope(disp,gid,exceptId){
  for(const s of DOC_ORDER){if(docId(s)===exceptId)continue;if(gidOf(s)!==gid)continue;if(docName(s)===disp)return true;}
  return false;
}
/* 取一个作用域内不重复的默认名「未命名剧本 N」；undefined/空 都按「未分组」算，与各组编号互不干扰 */
function nextDefaultName(groupId){const gid=groupId||'';let i=1;while(DOC_ORDER.some(s=>gidOf(s)===gid&&docName(s)==='未命名剧本 '+i))i++;return '未命名剧本 '+i;}
let grpTimer=null;
/* 分组是份小 JSON，顺手在本地留底：断网时列表还能照常显示分组关系 */
const GROUPS_LS='mujian_groups_cache';
function groupsCacheSet(g){try{localStorage.setItem(GROUPS_LS,JSON.stringify(g));}catch(e){}}
function groupsCacheGet(){try{return JSON.parse(localStorage.getItem(GROUPS_LS)||'null');}catch(e){return null;}}
function saveGroups(){
  clearTimeout(grpTimer);
  GDATA.updated=new Date().toISOString();   /* 本地改了分组 → 刷新时间戳，下次同步据此推到对端 */
  grpTimer=setTimeout(async()=>{
    try{await apiFetch('/api/groups',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({groups:GDATA.groups,docs:GDATA.docs,updated:GDATA.updated})});}catch(e){}
    groupsCacheSet(GDATA);   /* 本地先留底，断网也不丢分组归属 */
  },250);
}
async function loadGroups(){
  try{
    const r=await apiFetch('/api/groups');
    if(r.ok){
      const d=await r.json();
      GDATA={groups:Array.isArray(d.groups)?d.groups:[],
             docs:(d.docs&&typeof d.docs==='object')?d.docs:{},updated:(typeof d.updated==='string')?d.updated:null};
      groupsCacheSet(GDATA);
      return;
    }
  }catch(e){}
  const c=groupsCacheGet(); if(c)GDATA=c;   /* 离线 / 失败：用本地缓存撑起分组显示 */
}
let INIT_DOCS=null;
function initDocMeta(name){
  return {md:''};
}
function getInit(name){if(!INIT_DOCS)INIT_DOCS={};
  return INIT_DOCS[name]||(INIT_DOCS[name]=initDocMeta(name));}

/* ═════════════ 访问口令（云部署安全） ═════════════ */
const AUTH_KEY='mujian_key';          /* 本机（同源）服务器的访问口令，进页面 401 时填 */
/* ── 双端点模型 ──
   本机 = 打开这份程序的服务器（同源，或地址栏 ?api= 临时指定的那台）。
     所有正常读写（列表 / 打开 / 保存 / 删除 / 改名 / 分组 / 顺序）都打本机。
   云端 = 设置里填的「服务器地址」，只用于后台同步，是份可同步的副本。
   这样填了云端地址也不会丢掉本机 data/ 里的剧本：读写的永远是本机那份，
   云端只是个会自动跟上的镜像。（之前把填的地址当成唯一端点，才会读不到本机 data。） */
const CLOUD_BASE_KEY='mujian_api';    /* 云端同步地址（即原 API_BASE_KEY） */
const CLOUD_KEY='mujian_api_key';     /* 云端那台服务器的访问口令 */
/* 本机端点：地址栏 ?api= 可临时把整页指向另一台「本机」服务器 */
function localBase(){
  try{
    const q=new URLSearchParams(location.search).get('api');
    if(q&&q.trim())return q.trim().replace(/\/+$/,'');
  }catch(e){}
  return '';                           /* 空 = 同源（打开这份程序的服务器自己） */
}
/* 云端端点：设置里填的那台，留空 = 不做云端同步 */
function cloudBase(){
  let v='';
  try{v=localStorage.getItem(CLOUD_BASE_KEY)||'';}catch(e){}
  return v.trim().replace(/\/+$/,'');
}
function apiUrl(p){
  const key=localStorage.getItem(AUTH_KEY)||'';
  return localBase()+p+(p.indexOf('?')>-1?'&':'?')+'key='+encodeURIComponent(key);
}
function cloudApiUrl(p){
  const key=localStorage.getItem(CLOUD_KEY)||'';
  return cloudBase()+p+(p.indexOf('?')>-1?'&':'?')+'key='+encodeURIComponent(key);
}
async function apiFetch(p,opts){       /* 打本机服务器（所有正常读写都走这） */
  const r=await fetch(apiUrl(p),opts||{});
  if(r.status===401){showAuthGate();throw new Error('auth required');}
  return r;
}
async function cloudFetch(p,opts){     /* 打云端服务器，401 不弹本机口令框 */
  return fetch(cloudApiUrl(p),opts||{});
}
function showAuthGate(){
  const g=document.getElementById('authGate');
  if(g&&g.hidden){
    g.hidden=false;
    const i=document.getElementById('authInput');
    if(i){i.value='';setTimeout(()=>i.focus(),50);}
    const e=document.getElementById('authErr');
    if(e)e.textContent=localStorage.getItem(AUTH_KEY)?'口令不正确，请重新输入':'';
  }
}
function closeAuthGate(){const g=document.getElementById('authGate');if(g)g.hidden=true;}

/* ═════════════ 后端：加载文档 ═════════════ */
function applyDocDOM(d,init){
  const fm = d ? parseFront(d) : {meta:{},body:''};
  const body = (fm.body&&fm.body.trim()) ? fm.body : (init.md||'');
  /* 重画前先记下滚动位置和光标：同步后刷新列表经常是把同一份内容再画一遍，
     这时要保住它们，别把正在看的地方顶到头、把光标弄丢 */
  const ew=document.querySelector('.editor-wrap');
  const prevScroll=ew?ew.scrollTop:0;
  const prevSS=editor.selectionStart,prevSE=editor.selectionEnd,prevVal=editor.value;
  editor.value = body || '';               // 编辑区直接就是 md 源码
  /* 背景色 / 字体 / 字号都是全局偏好（存 localStorage），不再读文档头，直接用全局值 */
  setTheme(resolveTheme(),false);          /* 已在 head 里提前上色，这里只同步选中态 */
  applyFontKey(resolveFont(),false);
  setScriptSize(resolveFontSize(),false);
  const layoutOn=resolveLayout();   // 自动排版开关是全局偏好（存 localStorage），不读文档头
  prevPane.classList.toggle('raw',!layoutOn);   // 排版开关只作用于预览渲染
  document.getElementById('layoutBtn').classList.toggle('on',layoutOn);
  document.querySelectorAll('.font-item').forEach(x=>x.classList.toggle('on',x.dataset.font===curFontKey));
  undoStack=[];redoStack=[];lastSnap=editor.value;
  autoGrow();
  if(ew){
    /* 内容没变 → 保住当前滚动位置；内容真换了（新加载 / 云端覆盖）→ 回到顶部 */
    if(editor.value===prevVal)ew.scrollTop=prevScroll;
    else ew.scrollTop=0;
  }
  stat();renderOutline();
  /* 进入哪种视图：你手动选过就一直用那个；没选过才按内容自动决定
     （有内容看排版，空文档留在源码模式方便起笔）。
     先重渲染一遍预览区，保证它和 editor 同步——否则下面 exitPreview 回写会串台。 */
  renderPreview();
  const pm=prefMode();
  if(pm==='preview')enterPreview();
  else if(pm==='source'){if(document.body.classList.contains('preview'))exitPreview();}
  else if((editor.value||'').trim())enterPreview();
  else if(document.body.classList.contains('preview'))exitPreview();
  if(!document.querySelector('.tab[data-doc="'+curDoc+'"]'))appendTab(curDoc);
  markActive();
  updateChrome();
  /* 内容没变（典型如同步后重画列表）时还原光标，编辑过程中同步不该让光标跳走 */
  if(editor.value===prevVal && !document.body.classList.contains('preview')){
    try{if(!IS_TOUCH)editor.setSelectionRange(Math.min(prevSS,editor.value.length),Math.min(prevSE,editor.value.length));}catch(e){}
  }
}
async function loadDoc(name){
  curDoc=name;              /* 加载即接管：之后任何保存都写回这个文档，不会存错文件 */
  /* ① 主存储是本机服务器（同源那份 data/）：优先读它，秒开、且永远和本机文件一致。
     命中后把内容画出来，顺手垫进浏览器本地镜象（断网时才有用）。 */
  try{
    const r=await apiFetch('/api/doc/'+encodeURIComponent(name));
    if(r.ok){
      const d=await r.text();
      applyDocDOM(d,getInit(name));
      try{await localPutDoc({name,md:d,updated:updatedOfMd(d),groupId:gidOf(name)});}catch(e){}
      restoreView(name);
      return true;
    }
  }catch(e){}
  /* ② 本机连不上（服务没起 / 断网）→ 退回浏览器本地镜象，照样能开 */
  try{
    const local=await localGetDoc(name);
    if(local&&local.md!=null){applyDocDOM(local.md,getInit(name));restoreView(name);return true;}
  }catch(e){}
  /* ③ 本机没有、本地也没有 → 当作空文档（首次起笔） */
  applyDocDOM(null,getInit(name));
  restoreView(name);
  return true;
}
/* 切走前记下当前篇的滚动位置 + 光标（预览态记预览区滚动），切回来还原 */
function captureView(name){
  if(!name)return;
  const ew=document.querySelector('.editor-wrap');
  DOC_VIEW[name]={scrollTop:ew?ew.scrollTop:0,
    selStart:editor.selectionStart,selEnd:editor.selectionEnd,
    prevScroll:prevPane?prevPane.scrollTop:0};
}
/* 切回某篇时，把上次记下的位置还原回去（内容一致才有意义） */
function restoreView(name){
  const v=DOC_VIEW[name];
  if(!v)return;
  const ew=document.querySelector('.editor-wrap');
  if(ew)ew.scrollTop=v.scrollTop||0;
  if(document.body.classList.contains('preview')){
    if(prevPane)prevPane.scrollTop=v.prevScroll||0;
  }else{
    try{if(!IS_TOUCH)editor.setSelectionRange(Math.min(v.selStart||0,editor.value.length),
      Math.min(v.selEnd||0,editor.value.length));}catch(e){}
  }
}

/* ═════════════ 字号调节 ═════════════
   字号和字体、背景色一样是全局偏好：存 localStorage，换剧本、刷新都不变 */
/* 可调范围：写死在两个地方容易漏，收成常量 */
const FS_MIN=14,FS_MAX=32;
let fs=16;
function setScriptSize(v,save){fs=Math.max(FS_MIN,Math.min(FS_MAX,v));
  document.documentElement.style.setProperty('--script-size',fs+'px');
  editor.style.setProperty('--script-size',fs+'px');
  prevPane.style.setProperty('--script-size',fs+'px');
  document.getElementById('fsVal').textContent=fs;
  if(save!==false)prefSet(PREF.size,fs);}
/* 全局偏好优先；没手动调过就用文档里记的字号，再没有才是 16 */
function resolveFontSize(docSize){
  const s=parseInt(prefGet(PREF.size,''),10);
  if(s>=FS_MIN&&s<=FS_MAX)return s;
  const d=parseInt(docSize,10);
  return (d>=FS_MIN&&d<=FS_MAX)?d:16;
}
document.getElementById('fsMinus').onclick=()=>{setScriptSize(fs-1);};
document.getElementById('fsPlus').onclick=()=>{setScriptSize(fs+1);};

/* Ctrl+滚轮 调整正文字号 */
let wheelAcc=0,fsToast=null,fsToastTimer=null,fsPersistTimer=null;
function showFsToast(){
  if(!fsToast){fsToast=document.createElement('div');
    fsToast.style.cssText='position:fixed;left:50%;top:64px;transform:translateX(-50%);background:var(--ink-1);color:var(--bg);font-size:12px;padding:7px 16px;border-radius:999px;z-index:60;box-shadow:var(--shadow-pop);opacity:.95';
    document.body.appendChild(fsToast);}
  fsToast.textContent='正文字号 '+fs+'px';
  clearTimeout(fsToastTimer);
  /* 滚轮是连续的，停手 1.2 秒后再把字号落进文档 */
  clearTimeout(fsPersistTimer);
  fsPersistTimer=setTimeout(()=>{},1200);
  fsToastTimer=setTimeout(()=>{if(fsToast){fsToast.remove();fsToast=null;}},900);
}
/* 源码框和预览区都支持 Ctrl+滚轮调正文字号 */
function bindWheelZoom(el){
  if(!el)return;
  el.addEventListener('wheel',e=>{
    if(!e.ctrlKey)return;
    e.preventDefault();
    wheelAcc+=e.deltaY;
    while(wheelAcc>=40){setScriptSize(fs-1);wheelAcc-=40;}
    while(wheelAcc<=-40){setScriptSize(fs+1);wheelAcc+=40;}
    showFsToast();
  },{passive:false});
}
bindWheelZoom(editor);
bindWheelZoom(prevPane);

/* ═════════════ 自动排版（源码模式下作用于预览渲染） ═════════════ */
function setLayout(on){prevPane.classList.toggle('raw',!on);
  document.getElementById('layoutBtn').classList.toggle('on',on);
  prefSet(PREF.layout,on?'1':'0');   /* 记成全局偏好 */
  if(document.body.classList.contains('preview'))renderPreview();
  setUnsaved();}
document.getElementById('layoutBtn').onclick=()=>setLayout(prevPane.classList.contains('raw'));

/* ═════════════ 主题（背景颜色）切换 ═════════════
   背景颜色是「全局偏好」而不是某篇文档的属性：存在 localStorage 里，
   切换后立刻落盘，刷新、换设备打开、切到别的剧本都还是这个颜色。 */
/* ── 全局偏好：这些是「工作台的状态」而不是某篇文档的属性，
      存 localStorage，刷新 / 换剧本都不丢 ── */
const PREF={
  theme:'mujian_theme',   /* 背景颜色 */
  font :'mujian_font',    /* 正文字体 */
  size :'mujian_fontsize',/* 正文字号 */
  tabs :'mujian_tabs',    /* 多开的窗口（文档名数组） */
  cur  :'mujian_curdoc',  /* 当前正在编辑的剧本 */
  mode :'mujian_mode',    /* preview | source，你上次停在哪种视图 */
  zoom :'mujian_zoom',    /* 状态栏的显示比例（50~200%）——只影响看，不写进稿子 */
  outline:'mujian_outline',/* 左下角大纲的展开/折叠：1=折叠，0/缺省=展开 */
  layout:'mujian_layout'  /* 自动排版开关（只作用于预览渲染），全局偏好，不进文件头 */
};
function prefGet(k,d){try{const v=localStorage.getItem(k);return v===null?d:v;}catch(e){return d;}}
function prefSet(k,v){try{localStorage.setItem(k,String(v));}catch(e){}}
function prefDel(k){try{localStorage.removeItem(k);}catch(e){}}

const THEME_KEY=PREF.theme;
const THEMES=['paper','white','mist','ink'];
function getTheme(){return document.documentElement.getAttribute('data-theme')||'paper';}
/* 浏览器工具栏 / 应用窗口标题栏的上色：直接读当前主题的 --panel（顶栏就用它），
   颜色不用再抄一份到 JS 里，加主题也不会漏 */
function syncThemeColor(){
  const m=document.getElementById('themeColorMeta');
  if(!m)return;
  const c=getComputedStyle(document.documentElement).getPropertyValue('--panel').trim();
  if(c)m.setAttribute('content',c);
}
function setTheme(v,save){
  const t=THEMES.indexOf(v)>-1?v:'paper';
  document.documentElement.setAttribute('data-theme',t);
  syncThemeColor();
  if(save!==false){try{localStorage.setItem(THEME_KEY,t);}catch(e){}}
  document.querySelectorAll('.th-item').forEach(x=>{
    const on=x.dataset.themeSet===t;
    x.classList.toggle('on',on);
    const s=x.querySelector('span:last-child');if(s)s.textContent=on?'✓':'';
  });
}
/* 全局偏好优先；用户从没手动选过时，沿用该文档 frontmatter 里记的颜色 */
function resolveTheme(docTheme){
  let saved='';
  try{saved=localStorage.getItem(THEME_KEY)||'';}catch(e){}
  return THEMES.indexOf(saved)>-1?saved:(docTheme||'paper');
}
/* 背景色/字体/字号已是全局偏好（存 localStorage），不再写进文档 frontmatter，persistLookToDoc 已弃用 */
const pop=document.getElementById('themePop'),themeBtn=document.getElementById('themeBtn');
const fontPop=document.getElementById('fontPop'),fontBtn=document.getElementById('fontBtn');
const FONTS={
  yahei:'"Microsoft YaHei","PingFang SC","Noto Sans SC",system-ui,sans-serif',
  hei:'"SimHei","Heiti SC","STHeiti",sans-serif',
  kai:'"KaiTi","Kaiti SC","STKaiti",serif',
  wenkai:'"LXGW WenKai","KaiTi","Kaiti SC","STKaiti",serif',
  fang:'"FangSong","STFangsong","FangSong_GB2312",serif'
};
/* 当前字体只保存 key（yahei/hei/kai/wenkai/fang），不再保存整条 font-family，
   避免 CSS 串里的大量引号在 frontmatter 中被反复转义、越存越长 */
let curFontKey='yahei';
function applyFontKey(key,save){
  curFontKey=FONTS[key]?key:'yahei';
  const css=FONTS[curFontKey];
  /* 写到根元素上的变量：head 里的早鸟脚本也认这个变量，刷新时不会闪一下默认字体 */
  document.documentElement.style.setProperty('--script-font',css);
  editor.style.fontFamily=css;
  prevPane.style.fontFamily=css;
  document.querySelectorAll('.font-item').forEach(x=>x.classList.toggle('on',x.dataset.font===curFontKey));
  if(save!==false)prefSet(PREF.font,curFontKey);   /* 记成全局偏好 */
}
/* 全局偏好优先；你从没手动选过时，才沿用该文档 frontmatter 里记的字体 */
function resolveFont(docFont){
  const s=prefGet(PREF.font,'');
  if(FONTS[s])return s;
  return FONTS[docFont]?docFont:'yahei';
}
/* 自动排版开关已是全局偏好（存 localStorage），不再读文档头；缺省 false=不自动排版 */
function resolveLayout(){
  return prefGet(PREF.layout,'')==='1';
}
function placePop(el,btn){const r=btn.getBoundingClientRect();
  el.style.top=Math.round(r.bottom+8)+'px';
  el.style.left=Math.max(8,Math.min(r.left,innerWidth-el.offsetWidth-16))+'px';}
function openPop(){closeFontPop();placePop(pop,themeBtn);pop.classList.add('on');}
function closePop(){pop.classList.remove('on');}
function openFontPop(){closePop();placePop(fontPop,fontBtn);fontPop.classList.add('on');}
function closeFontPop(){fontPop.classList.remove('on');}
themeBtn.onclick=e=>{e.stopPropagation();pop.classList.contains('on')?closePop():openPop();};
fontBtn.onclick=e=>{e.stopPropagation();fontPop.classList.contains('on')?closeFontPop():openFontPop();};
document.querySelectorAll('.th-item').forEach(it=>it.onclick=async()=>{
  setTheme(it.dataset.themeSet,true);
  closePop();});
document.querySelectorAll('.font-item').forEach(it=>it.onclick=async()=>{
  applyFontKey(it.dataset.font,true);
  closeFontPop();setUnsaved();
});

/* ═════════════ 多开窗口：tabs / 文档库渲染与文档管理 ═════════════ */
/* 工作区（打开了哪些窗口、正在编辑哪一篇）存本地，刷新后原样恢复 */
function persistWorkspace(){
  prefSet(PREF.tabs,JSON.stringify(OPEN_TABS||[]));
  if(curDoc)prefSet(PREF.cur,curDoc);else prefDel(PREF.cur);
}
function restoreWorkspace(){
  let saved=[];
  try{saved=JSON.parse(prefGet(PREF.tabs,'[]'))||[];}catch(e){saved=[];}
  if(!Array.isArray(saved))saved=[];
  /* 只恢复真实存在的文档：删掉的、改名失效的一律丢掉，不留下幽灵标签 */
  const tabs=saved.filter(n=>typeof n==='string'&&DOC_ORDER.includes(n));
  const savedCur=prefGet(PREF.cur,'');
  let cur=DOC_ORDER.includes(savedCur)?savedCur:null;
  if(!tabs.length)return {tabs:DOC_ORDER.slice(0,1),cur:cur||DOC_ORDER[0]||null};
  if(cur&&!tabs.includes(cur))tabs.push(cur);
  return {tabs:tabs,cur:cur||tabs[0]};
}
function renderTabs(){
  const wrap=document.getElementById('tabs');
  wrap.innerHTML='';
  OPEN_TABS.forEach(name=>{
    const b=document.createElement('button');
    b.className='tab'+(name===curDoc?' on':'');
    b.dataset.doc=name;
    const tt=document.createElement('span');tt.className='tt';tt.textContent=docName(name);b.appendChild(tt);
    const x=document.createElement('span');x.className='x';x.title='关闭标签';
    x.innerHTML='<svg viewBox="0 0 256 256" fill="currentColor"><path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"/></svg>';
    x.onclick=e=>{e.stopPropagation();closeTab(name);};
    b.appendChild(x);
    b.onclick=()=>switchDoc(name);
    wrap.appendChild(b);
  });
  const nb=document.createElement('button');
  nb.className='tab new';
  nb.id='newTab';        /* 重建标签栏时 id 也要带回来，不然按 id 找它就找不到了 */
  nb.innerHTML='<svg viewBox="0 0 256 256" fill="currentColor"><path d="M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z"/></svg>新文档';
  nb.onclick=()=>newDoc();
  wrap.appendChild(nb);
  const sp=document.createElement('span');sp.className='sp';wrap.appendChild(sp);
  const info=document.createElement('span');
  info.style.cssText='font-size:11.5px;color:var(--ink-3)';
  info.textContent='多窗口 · 已打开 '+OPEN_TABS.length+' 个';
  wrap.appendChild(info);
  persistWorkspace();
}
const FOLD_SVG='<svg viewBox="0 0 256 256" fill="currentColor"><path d="M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z"/></svg>';
/* 组的行：左边角标控制展开/收起，点行=选中这个组，右键=组菜单 */
function makeGroupEl(g){
  const el=document.createElement('div');
  el.className='grp';
  el.dataset.k='g:'+g.id;
  el.dataset.grp=g.id;
  el.innerHTML='<span class="gname"></span><span class="gnum"></span>'+
    '<span class="fold" title="展开/收起">'+FOLD_SVG+'</span>';
  el.querySelector('.gname').textContent=g.name;
  el.querySelector('.fold').onclick=e=>{e.stopPropagation();toggleGroup(g.id);};
  el.onclick=()=>{toggleGroup(g.id);};
  return el;
}
function makeDocEl(name,inGroup){
  const card=document.createElement('div');
  card.className='lib-card'+(inGroup?' in-group':'');
  card.dataset.k='d:'+name;
  card.dataset.doc=name;
  const b=document.createElement('b');b.textContent=docName(name);
  /* 名字可能带引号/尖括号：一律用 textContent 写，别拼 HTML */
  card.innerHTML='<span class="meta"></span><button class="del" title="删除剧本">✕</button>';
  card.querySelector('.meta').appendChild(b);
  const del=card.querySelector('.del');
  del.addEventListener('mousedown',e=>e.preventDefault());   /* 保住重命名时的输入焦点 */
  del.onclick=e=>{
    e.stopPropagation();
    const nb=card.querySelector('.meta b');
    if(nb&&nb.classList.contains('renaming')){nb.textContent='';nb.focus();return;}  /* 编辑态：✕ = 清空 */
    delDoc(name);
  };
  card.onclick=()=>{if(card.querySelector('.meta b.renaming'))return;switchDoc(name);};
  return card;
}
function toggleGroup(id){
  const g=GDATA.groups.find(x=>x.id===id);
  if(!g)return;
  g.open=(g.open===false);
  saveGroups();renderLibrary();
}
/* 渲染「我的剧本」：组在上、未分组剧本在下，组收起时里面的剧本不显示。
   采用「按期望顺序就位」而不是整表重建——正在重命名的那一行不会被挪动，输入不中断 */
function renderLibrary(){
  const lib=document.getElementById('library');
  if(!lib)return;
  const seq=[];
  GDATA.groups.forEach(g=>{
    seq.push({k:'g:'+g.id,id:g.id,g:g});
    if(g.open!==false)docsInGroup(g.id).forEach(n=>seq.push({k:'d:'+n,name:n,inG:true}));
  });
  freeDocs().forEach(n=>seq.push({k:'d:'+n,name:n,inG:false}));
  const want=new Set(seq.map(x=>x.k));
  [...lib.children].forEach(el=>{if(!el.dataset.k||!want.has(el.dataset.k))el.remove();});
  let ref=lib.firstChild;
  seq.forEach(item=>{
    let el=[...lib.children].find(x=>x.dataset.k===item.k);
    if(!el)el=item.g?makeGroupEl(item.g):makeDocEl(item.name,item.inG);
    else if(!item.g)el.classList.toggle('in-group',!!item.inG);
    if(el===ref){ref=ref.nextSibling;}
    else{lib.insertBefore(el,ref);}
    if(item.g){
      el.classList.toggle('folded',item.g.open===false);
      el.querySelector('.gname').textContent=item.g.name;
      el.querySelector('.gnum').textContent=docsInGroup(item.g.id).length+' 篇';
    }
  });
  markActive();
}
/* 只更新高亮，不重建列表 */
function markActive(){
  document.querySelectorAll('.lib-card').forEach(c=>c.classList.toggle('on',c.dataset.doc===curDoc));
  document.querySelectorAll('.grp').forEach(g=>g.classList.toggle('on',g.dataset.grp===selGroup));
  document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('on',t.dataset.doc===curDoc));
  if(curDoc)prefSet(PREF.cur,curDoc);   /* 当前编辑的这篇随时记下，刷新后回到原处 */
}
/* 新增一个标签（不重建标签栏） */
function appendTab(name){
  const wrap=document.getElementById('tabs');
  const nb=wrap.querySelector('.tab.new');
  const b=document.createElement('button');
  b.className='tab';b.dataset.doc=name;
  const tt=document.createElement('span');tt.className='tt';tt.textContent=docName(name);b.appendChild(tt);
  const x=document.createElement('span');x.className='x';x.title='关闭标签';
  x.innerHTML='<svg viewBox="0 0 256 256" fill="currentColor"><path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"/></svg>';
  x.onclick=e=>{e.stopPropagation();closeTab(name);};
  b.appendChild(x);
  b.onclick=()=>switchDoc(name);
  wrap.insertBefore(b,nb);
  const sp=wrap.querySelector('.sp');
  if(sp&&sp.nextElementSibling)sp.nextElementSibling.textContent='多窗口 · 已打开 '+OPEN_TABS.length+' 个';
  persistWorkspace();
}
function removeTab(name){
  const tab=document.querySelector('.tab[data-doc="'+name+'"]');
  if(tab)tab.remove();
  const sp=document.getElementById('tabs').querySelector('.sp');
  if(sp&&sp.nextElementSibling)sp.nextElementSibling.textContent='多窗口 · 已打开 '+OPEN_TABS.length+' 个';
  persistWorkspace();
}
function updateChrome(){
  document.getElementById('docTitle').textContent=docName(curDoc)||'—';
  document.querySelector('.outline .side-h h3').textContent=(docName(curDoc)||'未命名')+' · 大纲';
}
/* 切换文档瞬间禁用过渡动画，完成后恢复（避免闪烁） */
async function noAnimScope(fn){
  document.body.classList.add('no-anim');
  try{await fn();}
  finally{
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    document.body.classList.remove('no-anim');
  }
}
async function switchDoc(name){
  if(!name||name===curDoc){closeNav();return;}
  closeNav();
  await noAnimScope(async()=>{
    captureView(curDoc);                 /* 先记下当前篇的位置 */
    await saveCurrentDoc(true);
    if(!OPEN_TABS.includes(name))OPEN_TABS.push(name);
    curDoc=name;
    show('data');
    await loadDoc(name);
  });
}
async function closeTab(name){
  await noAnimScope(async()=>{
    if(name===curDoc)await saveCurrentDoc(true);
    captureView(curDoc);                 /* 记下落掉这篇前的位置，以后重开还能还原 */
    const idx=OPEN_TABS.indexOf(name);
    OPEN_TABS=OPEN_TABS.filter(n=>n!==name);
    if(curDoc===name)curDoc=OPEN_TABS.length?OPEN_TABS[Math.min(idx,OPEN_TABS.length-1)]:null;
    removeTab(name);
    if(curDoc){show('data');await loadDoc(curDoc);}else show('empty');
  });
}
function newDoc(groupId){
  noAnimScope(async()=>{
    captureView(curDoc);                 /* 先记下当前篇的位置 */
    await saveCurrentDoc(true);
    const wasPreview=document.body.classList.contains('preview');
    /* 显示名只在「同作用域」内避重：不同组 / 未分组可以各自有「未命名剧本 1」 */
    const nid=newDocId();
    const disp=nextDefaultName(groupId);
    const identity=docIdentity(disp,nid);
    DOC_ORDER.push(identity);OPEN_TABS.push(identity);
    curDoc=identity;
    /* 选中了组（或从这个组里点的新建）→ 新剧本直接落进组里 */
    if(groupId&&GDATA.groups.some(g=>g.id===groupId))GDATA.docs[identity]=groupId;
    saveGroups();
    appendTab(identity);
    renderLibrary();
    updateChrome();
    editor.value='';undoStack=[];redoStack=[];lastSnap='';autoGrow();
    show('data');
    stat();renderOutline();
    /* 预览区同步清空——不能走 exitPreview()，那会把上一份剧本的 DOM 回写成新剧本的内容 */
    if(wasPreview){
      prevPane.innerHTML='<p class="action" data-line="0" data-blank="1"></p>';
      document.body.classList.add('preview');
      editor.hidden=true;prevPane.hidden=false;
      document.getElementById('previewLabel').textContent='查看源码';
      const first=prevPane.firstElementChild;
      const r=document.createRange();r.selectNodeContents(first);r.collapse(true);
      const s=getSelection();s.removeAllRanges();s.addRange(r);
      if(!IS_TOUCH)prevPane.focus();
    }else{
      if(document.body.classList.contains('preview'))exitPreview();
      if(!IS_TOUCH)editor.focus();autoGrow();
    }
  });
}
/* ═════════════ 组：新建 / 重命名 / 删除 ═════════════ */
function newGroupId(){let i=1,id;do{id='g'+i;i++;}while(GDATA.groups.some(g=>g.id===id));return id;}
function newGroup(){
  const id=newGroupId();
  let i=1,n;do{n='新组 '+i;i++;}while(GDATA.groups.some(g=>g.name===n));
  GDATA.groups.push({id:id,name:n,open:true});
  selGroup=id;
  saveGroups();renderLibrary();
  renameGroup(id);           /* 建好就进编辑态，直接打名字，回车确认 */
}
/* 原地改组名：回车确认 / Esc 取消，和剧本重命名一个手感 */
function renameGroup(id){
  const el=[...document.querySelectorAll('.grp')].find(x=>x.dataset.grp===id);
  if(!el)return;
  const b=el.querySelector('.gname');
  if(!b||b.classList.contains('renaming'))return;
  const old=b.textContent;
  let done=false;
  const stop=()=>{done=true;b.classList.remove('renaming');b.removeAttribute('contenteditable');
    b.onkeydown=null;b.onblur=null;};
  b.classList.add('renaming');
  b.setAttribute('contenteditable','true');
  b.spellcheck=false;
  b.focus();
  const r=document.createRange();r.selectNodeContents(b);
  const s=getSelection();s.removeAllRanges();s.addRange(r);
  b.onkeydown=e=>{
    if(e.key==='Enter'){e.preventDefault();e.stopPropagation();b.blur();}
    else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();stop();b.textContent=old;}
  };
  b.onblur=()=>{
    if(done)return;
    const t=(b.textContent||'').trim();
    stop();
    if(!t||t===old){b.textContent=old;return;}
    const g=GDATA.groups.find(x=>x.id===id);
    if(!g)return;
    g.name=t;saveGroups();renderLibrary();
    showToast('组已改名为「'+t+'」');
  };
}
/* 删组：mode='keep' 把剧本移到未分组；mode='drop' 连同剧本一起删 */
async function doDelGroup(id,mode){
  const g=GDATA.groups.find(x=>x.id===id);
  if(!g)return;
  const docs=docsInGroup(id);
  if(mode==='drop'){
    for(const d of docs)await doDel(d);
  }
  GDATA.groups=GDATA.groups.filter(x=>x.id!==id);
  if(mode!=='drop'){
    docs.forEach(k=>{if(GDATA.docs[k]===id)delete GDATA.docs[k];});
  }
  if(selGroup===id)selGroup=null;
  saveGroups();renderLibrary();
  const n=docs.length;
  let extra='';
  if(n){extra = mode==='drop' ? ('，'+n+' 篇剧本已删除') : ('，'+n+' 篇剧本回到未分组');}
  showToast('已删除组「'+g.name+'」'+extra);
}

let pendingDel=null;
let pendingDelGroupId=null;
function askDel(name){
  pendingDel={kind:'doc',name:name};
  document.getElementById('confirmMsg').textContent='删除剧本「'+docName(name)+'」？删除后无法恢复。';
  openModal('confirmModal');
}
function askDelGroup(id){
  const g=GDATA.groups.find(x=>x.id===id);
  const n=docsInGroup(id).length;
  pendingDelGroupId=id;
  const msg=document.getElementById('groupDelMsg');
  if(msg)msg.textContent='删除组「'+(g?g.name:'')+'」？组里有 '+n+' 篇剧本，要如何处理？';
  openModal('groupDelModal');
}
async function doDel(name){
  await noAnimScope(async()=>{
    let at=null;
    try{
      const r=await apiFetch('/api/doc/'+encodeURIComponent(name),{method:'DELETE'});
      if(r.ok){try{const j=await r.json();at=j&&j.updated;}catch(e){}}
      else syncOffline=true;
    }catch(e){syncOffline=true;}
    /* 本地留下来墓碑，而不是直接忘掉这出戏：
       不然点同步的时候，云端那份还活着的会被当成「本地缺了这一篇」又拉回来 */
    if(at)await localMarkDeleted(name,at);
    else{await localMarkDeleted(name,new Date().toISOString());markPending();}
    if(INIT_DOCS)delete INIT_DOCS[name];
    DOC_ORDER=DOC_ORDER.filter(n=>n!==name);
    OPEN_TABS=OPEN_TABS.filter(n=>n!==name);
    if(GDATA.docs[name]!=null){delete GDATA.docs[name];saveGroups();}
    if(curDoc===name){
      curDoc=DOC_ORDER[0]||null;
      if(curDoc&&!OPEN_TABS.includes(curDoc)){OPEN_TABS.push(curDoc);appendTab(curDoc);}
    }
    removeTab(name);
    renderLibrary();
    if(curDoc===name)prefDel(PREF.cur);
    persistWorkspace();
    if(curDoc){show('data');await loadDoc(curDoc);}else show('empty');
  });
}
function delDoc(name){askDel(name);}
document.getElementById('confirmCancel').onclick=()=>{pendingDel=null;closeModals();};

/* ═════════════ 我的剧本 · 右键菜单（重命名 / 上移 / 下移） ═════════════ */
/* 按剧名找卡片：直接比对 dataset，避免名字里的引号破坏属性选择器 */
const findCard=n=>[...document.querySelectorAll('.lib-card')].find(c=>c.dataset.doc===n);
const docMenu=document.getElementById('docMenu');
let menuDoc=null;
function openDocMenu(name,x,y){
  menuDoc=name;
  const inGrp=!!gidOf(name);
  const toGrp=docMenu.querySelector('[data-act="togrp"]');
  const outGrp=docMenu.querySelector('[data-act="outgrp"]');
  if(toGrp){toGrp.hidden=inGrp;toGrp.disabled=!GDATA.groups.length;}
  if(outGrp)outGrp.hidden=!inGrp;
  const idx=DOC_ORDER.indexOf(name);
  docMenu.querySelector('[data-act="up"]').disabled=(idx<=0);
  docMenu.querySelector('[data-act="down"]').disabled=(idx<0||idx>=DOC_ORDER.length-1);
  docMenu.classList.add('on');
  const r=docMenu.getBoundingClientRect();
  let px=x,py=y;
  if(px+r.width>window.innerWidth)px=window.innerWidth-r.width-8;
  if(py+r.height>window.innerHeight)py=window.innerHeight-r.height-8;
  docMenu.style.left=px+'px';
  docMenu.style.top=py+'px';
}
function closeDocMenu(){docMenu.classList.remove('on');menuDoc=null;}
document.getElementById('library').addEventListener('contextmenu',e=>{
  const grp=e.target.closest('.grp');
  if(grp&&grp.dataset.grp){
    e.preventDefault();
    selGroup=grp.dataset.grp;markActive();
    closeDocMenu();newMenu.classList.remove('on');
    openGrpMenu(grp.dataset.grp,e.clientX,e.clientY);
    return;
  }
  const card=e.target.closest('.lib-card');
  if(!card||!card.dataset.doc)return;            // 仅拦截剧本卡片，空白处仍弹系统菜单
  e.preventDefault();
  closeMenus();
  openDocMenu(card.dataset.doc,e.clientX,e.clientY);
});
document.addEventListener('click',e=>{
  if(docMenu.classList.contains('on')&&!docMenu.contains(e.target))closeDocMenu();
  if(grpMenu.classList.contains('on')&&!grpMenu.contains(e.target))grpMenu.classList.remove('on');
  if(newMenu.classList.contains('on')&&!newMenu.contains(e.target))newMenu.classList.remove('on');
  if(grpPickMenu.classList.contains('on')&&!grpPickMenu.contains(e.target))grpPickMenu.classList.remove('on');
});
document.addEventListener('scroll',closeMenus,true);
window.addEventListener('blur',closeMenus);

/* ═════════════ 组的右键菜单：新建剧本 / 重命名 / 删除组 ═════════════ */
const grpMenu=document.getElementById('grpMenu');
let menuGrp=null;
function openGrpMenu(id,x,y){
  menuGrp=id;
  grpMenu.classList.add('on');
  const r=grpMenu.getBoundingClientRect();
  let px=x,py=y;
  if(px+r.width>window.innerWidth)px=window.innerWidth-r.width-8;
  if(py+r.height>window.innerHeight)py=window.innerHeight-r.height-8;
  grpMenu.style.left=px+'px';
  grpMenu.style.top=py+'px';
}
/* 三个菜单（剧本 / 组 / 新建）共用一个收起动作 */
function closeMenus(){
  docMenu.classList.remove('on');menuDoc=null;
  grpMenu.classList.remove('on');menuGrp=null;
  grpPickMenu.classList.remove('on');pickDoc=null;
  newMenu.classList.remove('on');
}
grpMenu.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  const act=b.dataset.act,id=menuGrp;closeMenus();
  if(!id)return;
  if(act==='newdoc')newDoc(id);
  else if(act==='rename')renameGroup(id);
  else if(act==='del')askDelGroup(id);
});

/* ═════════════ 「+」号：新建剧本 / 新建组 ═════════════ */
const newMenu=document.getElementById('newMenu');
const newDocBtnEl=document.getElementById('newDocBtn');
function placeMenuAt(el,btn){
  el.classList.add('on');
  const r=btn.getBoundingClientRect();
  const w=el.offsetWidth||150,h=el.offsetHeight||76;
  el.style.left=Math.max(8,Math.min(r.left,innerWidth-w-8))+'px';
  el.style.top=Math.round(r.bottom+6)+'px';
  if(parseFloat(el.style.top)+h>innerHeight)el.style.top=Math.max(8,r.top-h-6)+'px';
}
newDocBtnEl.onclick=e=>{
  e.stopPropagation();
  if(newMenu.classList.contains('on')){closeMenus();return;}
  closeMenus();placeMenuAt(newMenu,newDocBtnEl);
};
newMenu.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  const act=b.dataset.act;closeMenus();
  if(act==='doc')newDoc();            /* 默认建到「未分组」，不受当前选中组影响 */
  else if(act==='grp')newGroup();
});
docMenu.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b||b.disabled)return;
  /* 别让这一下冒泡到 document 的「点外面就收起」——否则「移到组」弹出的
     二级菜单会在同一轮事件里被立刻关掉，闪一下就没了 */
  e.stopPropagation();
  const act=b.dataset.act,name=menuDoc;
  const r=b.getBoundingClientRect();
  closeMenus();
  if(!name)return;
  if(act==='rename')renameDoc(name);
  else if(act==='up')moveDoc(name,-1);
  else if(act==='down')moveDoc(name,1);
  else if(act==='togrp')openGrpPick(name,r.right+4,r.top-6);
  else if(act==='outgrp')moveDocOutGroup(name);
});

/* ═════════════ 剧本归组：移到组（选一个）/ 移出组 ═════════════ */
const grpPickMenu=document.getElementById('grpPickMenu');
let pickDoc=null;
function openGrpPick(name,x,y){
  pickDoc=name;
  grpPickMenu.innerHTML='';
  if(!GDATA.groups.length){
    const tip=document.createElement('div');
    tip.className='tip';tip.textContent='还没有组，先点 + 号新建';
    grpPickMenu.appendChild(tip);
  }
  GDATA.groups.forEach(g=>{
    const b=document.createElement('button');
    b.dataset.gid=g.id;
    /* 当前所在的组打个勾，一眼知道它在哪儿 */
    b.innerHTML='<svg viewBox="0 0 256 256" fill="currentColor"><path d="M216,72H128a8,8,0,0,1-8-8V40H48A16,16,0,0,0,32,56v144a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V88A16,16,0,0,0,216,72ZM120,32h32a8,8,0,0,1,8,8v16a8,8,0,0,1-8,8H120a8,8,0,0,1-8-8V40A8,8,0,0,1,120,32Z"/></svg>';
    const sp=document.createElement('span');sp.textContent=g.name;b.appendChild(sp);
    if(gidOf(name)===g.id){const t=document.createElement('span');
      t.style.cssText='margin-left:auto;font-size:11px;color:var(--accent)';t.textContent='✓';b.appendChild(t);}
    b.onclick=()=>{const n=pickDoc;closeMenus();if(n)moveDocToGroup(n,g.id);};
    grpPickMenu.appendChild(b);
  });
  grpPickMenu.classList.add('on');
  const rc=grpPickMenu.getBoundingClientRect();
  let px=x,py=y;
  if(px+rc.width>window.innerWidth)px=Math.max(8,x-rc.width-8);
  if(py+rc.height>window.innerHeight)py=window.innerHeight-rc.height-8;
  grpPickMenu.style.left=Math.max(8,px)+'px';
  grpPickMenu.style.top=Math.max(8,py)+'px';
}
function moveDocToGroup(name,gid){
  const g=GDATA.groups.find(x=>x.id===gid);
  if(!g)return;
  GDATA.docs[name]=gid;
  g.open=true;               /* 移进去就展开，别让人以为剧本凭空没了 */
  saveGroups();renderLibrary();
  showToast('已把「'+docName(name)+'」移到「'+g.name+'」');
}
function moveDocOutGroup(name){
  if(GDATA.docs[name]==null)return;
  delete GDATA.docs[name];
  saveGroups();renderLibrary();
  showToast('已把「'+docName(name)+'」移出组');
}
/* 执行重命名（不含输入环节，供原地编辑 / 其它入口复用） */
async function doRename(name,t){
  if(!t||t===docName(name))return false;
  if(displayTakenInScope(t,gidOf(name),docId(name))){showToast('已存在同名剧本「'+t+'」');return false;}
  if(curDoc===name)await saveCurrentDoc(true);    // 先把当前内容落盘到旧名
  const newIdentity=docIdentity(t,docId(name));   // id 不变，只换显示名那段
  try{
    const r=await apiFetch('/api/doc/rename',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({id:docId(name),name:t})});
    if(r.status===409){showToast('已存在同名剧本「'+t+'」');return false;}
    if(!r.ok)throw new Error('http '+r.status);
    /* 本地那份跟着换名字，同步时才不会被当成「删一篇 + 多一篇」来回折腾 */
    await localRename(name,newIdentity);
    const fi=DOC_ORDER.indexOf(name);if(fi>=0)DOC_ORDER[fi]=newIdentity;
    const oi=OPEN_TABS.indexOf(name);if(oi>=0)OPEN_TABS[oi]=newIdentity;
    if(GDATA.docs[name]!=null){const gid=GDATA.docs[name];delete GDATA.docs[name];GDATA.docs[newIdentity]=gid;saveGroups();}
    if(curDoc===name)curDoc=newIdentity;
    if(INIT_DOCS)delete INIT_DOCS[name];
    /* 成功后再改卡片 data-doc，让 renderLibrary 认得它，避免整表重建导致跳位 */
    const card=findCard(name);
    if(card)card.dataset.doc=newIdentity;
    renderLibrary();renderTabs();updateChrome();markActive();
    showToast('已重命名为「'+t+'」');
    return true;
  }catch(e){showToast('重命名失败，请稍后再试');return false;}
}
/* 原地重命名：把列表里的名字直接变成可编辑，回车确认 / Esc 取消 */
function renameDoc(name){
  const card=findCard(name);
  if(!card)return;
  const b=card.querySelector('.meta b');
  if(!b||b.classList.contains('renaming'))return;
  const del=card.querySelector('.del');
  let done=false;
  const stop=()=>{
    done=true;
    b.classList.remove('renaming');
    b.removeAttribute('contenteditable');
    b.onkeydown=null;b.onblur=null;
    card.classList.remove('renaming');
    if(del){del.textContent='✕';del.title='删除剧本';}
  };
  card.classList.add('renaming');
  if(del){del.textContent='⌫';del.title='清除文本';}
  b.classList.add('renaming');
  b.setAttribute('contenteditable','true');
  b.spellcheck=false;
  b.focus();
  const r=document.createRange();r.selectNodeContents(b);
  const s=getSelection();s.removeAllRanges();s.addRange(r);
  b.onkeydown=e=>{
    if(e.key==='Enter'){e.preventDefault();e.stopPropagation();b.blur();}
    else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();stop();b.textContent=docName(name);b.blur();}
  };
  b.onblur=()=>{
    if(done)return;
    const t=(b.textContent||'').trim();
    stop();
    if(!t||t===docName(name)){b.textContent=docName(name);return;}
    doRename(name,t).then(okR=>{if(!okR)b.textContent=docName(name);});
  };
}
async function moveDoc(name,dir){
  /* 只跟同组的邻居换位：跨组跳到别的组里不是这个菜单该干的事 */
  const list=DOC_ORDER.filter(n=>gidOf(n)===gidOf(name));
  const li=list.indexOf(name);
  if(li<0||li+dir<0||li+dir>=list.length){showToast(dir<0?'已经在最上面':'已经在最下面');return;}
  const idx=DOC_ORDER.indexOf(name),ni=DOC_ORDER.indexOf(list[li+dir]);
  if(idx<0||ni<0)return;
  [DOC_ORDER[idx],DOC_ORDER[ni]]=[DOC_ORDER[ni],DOC_ORDER[idx]];
  /* 标签栏同步顺序（已开标签跟随 DOC_ORDER 排列） */
  OPEN_TABS=DOC_ORDER.filter(n=>OPEN_TABS.includes(n)).concat(OPEN_TABS.filter(n=>!DOC_ORDER.includes(n)));
  try{
    await apiFetch('/api/order',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({order:DOC_ORDER})});
  }catch(e){/* 本地已更新，后端失败也保留前端顺序 */}
  renderLibrary();renderTabs();markActive();
  showToast(dir<0?'已上移':'已下移');
}
document.getElementById('confirmOk').onclick=()=>{
  closeModals();
  const act=pendingDel;pendingDel=null;
  if(!act)return;
  if(act.kind==='doc')doDel(act.name);
};
/* 删除组：在弹窗里选「移到未分组」还是「连同删除」 */
document.getElementById('groupDelCancel').onclick=()=>{pendingDelGroupId=null;closeModals();};
document.getElementById('groupDelKeep').onclick=()=>{const id=pendingDelGroupId;pendingDelGroupId=null;closeModals();if(id)doDelGroup(id,'keep');};
document.getElementById('groupDelDrop').onclick=()=>{const id=pendingDelGroupId;pendingDelGroupId=null;closeModals();if(id)doDelGroup(id,'drop');};
/* 「+」号改成菜单：见上方 newMenu 逻辑 */
document.getElementById('emptyNew').onclick=()=>newDoc();
document.getElementById('emptyImport').onclick=openImport;
const outlineEl=()=>document.querySelector('.outline');
function setOutlineCollapsed(on){
  const o=outlineEl();
  if(!o)return;
  o.classList.toggle('collapsed',on);
  document.querySelector('.library').classList.toggle('grow',on);
  prefSet(PREF.outline,on?'1':'0');   /* 折叠/展开状态持久化，刷新后保持 */
}
document.getElementById('outlineFold').onclick=()=>{
  setOutlineCollapsed(!outlineEl().classList.contains('collapsed'));
};

/* ═════════════ 弹窗通用 ═════════════ */
const scrim=document.getElementById('scrim');
function openModal(id,noScrim){closePop();closeFontPop();closeModals();
  document.getElementById(id).classList.add('on');
  if(!noScrim)scrim.classList.add('on');}
function closeModals(){document.querySelectorAll('.modal').forEach(m=>m.classList.remove('on'));
  scrim.classList.remove('on');
  figReplaceMode=false;
  const tm=document.getElementById('imgModalTitle');
  if(tm)tm.textContent='插入图片';
  const fi=document.getElementById('figInsert');
  if(fi)fi.textContent='插入到剧本';}
scrim.onclick=()=>{closeModals();closePop();closeFontPop();};
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>{closeModals();closePop();closeFontPop();});

/* ═════════════ 搜索替换（基于 md 源码文本） ═════════════
   面板贴在「查找替换」按钮正下方，背景不变暗，改完一眼能对照到稿子上 */
const searchBtnEl=document.getElementById('searchBtn');
const searchPanel=document.getElementById('searchModal');
const findInputEl=document.getElementById('findInput');
function placeSearchPanel(){
  searchPanel.classList.add('pop-panel');
  const r=searchBtnEl.getBoundingClientRect();
  const w=searchPanel.offsetWidth||360;
  searchPanel.style.top=Math.round(r.bottom+8)+'px';
  searchPanel.style.left=Math.max(8,Math.min(r.left,innerWidth-w-16))+'px';
}
function openSearchPanel(){
  /* 不强制切回源码：点查找就停在用户当前的视图（预览/源码都保持），
     查找替换照常作用在源码上，预览态下替换后实时重渲染预览区 */
  closePop();closeFontPop();closeModals();
  placeSearchPanel();
  searchPanel.classList.add('on');
  /* 已经选中了一段文字就直接拿去当查找词，少打一遍 */
  const sel=editor.value.slice(editor.selectionStart,editor.selectionEnd);
  if(sel&&sel.indexOf('\n')<0)findInputEl.value=sel;
  fbSet('准备就绪',1);
  setTimeout(()=>{findInputEl.focus();findInputEl.select();},30);
}
/* 开一次、关一次：只有「查找替换」按钮和 Ctrl/⌘+F 能收起它，
   点在稿子里、点别处都不会消失（Esc 也行） */
function toggleSearchPanel(){
  if(searchPanel.classList.contains('on'))closeModals();
  else openSearchPanel();
}
searchBtnEl.onclick=e=>{
  e.stopPropagation();
  toggleSearchPanel();
};
/* Ctrl+F / ⌘F 接管：按一次弹出、再按一次收起，浏览器自带的搜索条不再出来 */
document.addEventListener('keydown',e=>{
  if(!(e.ctrlKey||e.metaKey)||e.altKey)return;
  const k=(e.key||'').toLowerCase();
  if(k==='f'||e.keyCode===70){
    e.preventDefault();   /* 拦掉浏览器自带的查找条 */
    toggleSearchPanel();
  }
},true);
/* 滚动到指定字符偏移处：截断法算出目标高度后还原原文 */
/* textarea 高度随内容增长：不出现内部滚动条，内容一直排到页面底部 */
function autoGrow(){
  if(document.body.classList.contains('preview'))return;
  editor.style.height='auto';
  editor.style.height=editor.scrollHeight+'px';
}
/* 滚动到指定字符偏移：截断法量出目标位置的高度，再滚动外层容器 */
function revealPos(pos){
  const ew=document.querySelector('.editor-wrap');
  if(!ew)return;
  const ss=editor.selectionStart,se=editor.selectionEnd,old=editor.value;
  editor.style.height='auto';
  editor.value=old.slice(0,pos);
  const h=editor.scrollHeight;                 /* 目标位置之前的内容高度 */
  editor.value=old;
  autoGrow();
  editor.setSelectionRange(ss,se);
  const er=ew.getBoundingClientRect(),r=editor.getBoundingClientRect();
  ew.scrollTop=Math.max(0,(r.top-er.top)+ew.scrollTop+h-ew.clientHeight/3);
}
/* 查找游标：连续点「查找」依次跳到下一处，到底了回到开头接着来 */
let findCursor=0;
function findNext(term){
  const v=editor.value;
  const total=v.split(term).length-1;
  if(!total)return {n:0};
  let i=v.indexOf(term,findCursor),wrapped=false;
  if(i<0){i=v.indexOf(term);wrapped=true;
    if(i<0)return {n:0};}
  editor.focus();
  editor.setSelectionRange(i,i+term.length);
  revealPos(i);                       /* 滚过去，让人看得见那处高亮 */
  findCursor=i+term.length;
  return {n:total,i:i,wrapped:wrapped,order:v.slice(0,i).split(term).length};
}
function findText(term){
  findCursor=0;
  return findNext(term).n;
}
function clearMarks(){} /* 源码模式没有 <mark> 节点，保留空实现以兼容调用点 */
function replaceInText(from,to,all){
  const v=editor.value;
  if(!from||!v.includes(from))return 0;
  if(all){
    const n=v.split(from).length-1;
    editor.value=v.split(from).join(to);autoGrow();
    lastSnap=editor.value;stat();renderOutline();setUnsaved();
    if(document.body.classList.contains('preview'))renderPreview();
    findCursor=0;
    return n;
  }
  /* 单个：替换当前定位的这一处，替换后仍停在这一处，方便连着点 */
  let i=v.indexOf(from,Math.max(0,findCursor-from.length));
  if(i<0)i=v.indexOf(from);
  if(i<0)return 0;
  editor.value=v.slice(0,i)+to+v.slice(i+from.length);autoGrow();
  editor.focus();editor.setSelectionRange(i,i+to.length);revealPos(i);
  findCursor=i+to.length;
  lastSnap=editor.value;stat();renderOutline();setUnsaved();
  if(document.body.classList.contains('preview'))renderPreview();
  return 1;
}
const fb=document.getElementById('fbLine'),fbText=document.getElementById('fbText');
function fbSet(msg,empty){fb.classList.toggle('empty',!!empty);fbText.textContent=msg;}
const repInputEl=document.getElementById('repInput');
function runFind(){
  const term=findInputEl.value.trim();
  if(!term){fbSet('请输入查找内容',1);return;}
  const r=findNext(term);
  if(!r.n){fbSet('未找到「'+term+'」',1);return;}
  fbSet('第 '+r.order+' / '+r.n+' 处'+(r.wrapped?' · 已回到开头':''),0);
}
document.getElementById('findBtn').onclick=runFind;
/* 输入框里直接回车 = 找下一处，连着敲就能逐个走过去 */
[findInputEl,repInputEl].forEach(el=>el.addEventListener('keydown',e=>{
  if(e.key==='Enter'){e.preventDefault();runFind();}
  else if(e.key==='Escape'){e.preventDefault();closeModals();}
}));
function runRepAll(){
  const term=findInputEl.value.trim(),to=repInputEl.value;
  if(!term){fbSet('请输入查找内容',1);return;}
  const n=replaceInText(term,to,true);
  fbSet(n?('全部替换完成，共 '+n+' 处'):('未找到「'+term+'」'),!n);
  stat();setUnsaved();
}
document.getElementById('repBtn').onclick=()=>{
  const term=findInputEl.value.trim(),to=repInputEl.value;
  if(!term){fbSet('请输入查找内容',1);return;}
  const left=(editor.value.split(term).length-1);
  const n=replaceInText(term,to,false);
  if(!n){fbSet('未找到「'+term+'」',1);return;}
  const after=editor.value.split(term).length-1;
  fbSet('已替换 1 处'+(after?('，还剩 '+after+' 处'):'，已全部替换完'),0);
  stat();setUnsaved();
};
document.getElementById('repAllBtn').onclick=runRepAll;

/* ═════════════ 插入图片 ═════════════ */
let figReplaceMode=false,figReplaceLine=-1;
function openImgModal(replace){
  openModal('imgModal');
  figReplaceMode=!!replace;
  if(!replace)figReplaceLine=-1;
  document.getElementById('imgModalTitle').textContent=figReplaceMode?'更换图片':'插入图片';
  document.getElementById('figInsert').textContent=figReplaceMode?'确认更换':'插入到剧本';
}
document.getElementById('imgBtn').onclick=()=>openImgModal(false);
/* 默认就选中弹窗里的预览图，避免没上传就点插入导致插进一张空地址 */
let pickSrc=document.getElementById('pickPrev')?document.getElementById('pickPrev').src:'';
let pickPct=90;
/* 候选图区：没有图源时至少把当前预览图做成一张可选卡片 */
(function initPickGrid(){
  const g=document.getElementById('pickGrid');
  if(!g||g.children.length||!pickSrc)return;
  const d=document.createElement('div');
  d.className='pick on';
  d.title='当前预览图';
  const im=document.createElement('img');
  im.src=pickSrc;im.alt='预览图';
  d.appendChild(im);
  d.onclick=()=>{
    document.querySelectorAll('.pick').forEach(x=>x.classList.remove('on'));
    d.classList.add('on');
    pickSrc=document.getElementById('pickPrev').src;
  };
  g.appendChild(d);
})();
document.getElementById('figRange').oninput=e=>{
  pickPct=+e.target.value;document.getElementById('figPct').textContent=pickPct+'%';
  document.getElementById('pickPrev').style.width=pickPct+'%';
  document.getElementById('pickPrev').style.height='auto';};
function reFigBind(){} /* 源码模式没有 DOM 图片元素，保留空实现以兼容旧调用点 */
/* 在 textarea 光标处插入一段文本（自动补换行） */
function insertAtCursor(txt){
  const s=editor.selectionStart,e=editor.selectionEnd,v=editor.value;
  const before=v.slice(0,s),after=v.slice(e);
  const pre=(before===''||before.endsWith('\n'))?'':'\n';
  const ins=pre+txt+'\n';
  editor.value=before+ins+after;autoGrow();
  const pos=s+pre.length+txt.length;
  editor.setSelectionRange(pos,pos);
  editor.focus();
  lastSnap=editor.value;
  stat();renderOutline();setUnsaved();
}
const FIG_RE=/!\[[^\]]*\]\([^)\s]+\)(?:\s*\{w=\d+\})?/;
/* 插入点：预览模式看光标所在块，源码模式看光标所在行；
   右键「更换图片」时直接用记下的行号，避免弹窗抢焦点后定位丢失 */
function figTargetLine(){
  if(figReplaceLine>=0)return {i:figReplaceLine,on:true};
  if(document.body.classList.contains('preview')){
    const el=previewBlockAtCaret();
    if(!el)return {i:editor.value.split('\n').length,on:false};
    const i=+el.getAttribute('data-line')||0;
    return el.classList.contains('fig')?{i:i,on:true}:{i:i+1,on:false};
  }
  const v=editor.value,s=editor.selectionStart;
  return {i:v.slice(0,s).split('\n').length-1,on:false};
}
function lineRangeByIdx(i){
  const lines=editor.value.split('\n');
  let pos=0;
  for(let k=0;k<i&&k<lines.length;k++)pos+=lines[k].length+1;
  return {ls:pos,le:pos+((lines[i]||'').length)};
}
/* 图片语法按整行写入源码，源码 / 预览两种模式都走这里，插完立即重新渲染 */
function insertFigMd(md,replace){
  const t=figTargetLine();
  const lines=editor.value.split('\n');
  let i=Math.max(0,Math.min(t.i,lines.length));
  const hit=replace&&FIG_RE.test(lines[i]||'')
    ? i
    : (replace&&i>0&&FIG_RE.test(lines[i-1]||'')?i-1:-1);
  undoStack.push(editor.value);
  if(undoStack.length>60)undoStack.shift();
  redoStack=[];
  if(hit>=0){
    lines[hit]=lines[hit].replace(FIG_RE,md);
  }else{
    const ins=[];
    if(i>0&&(lines[i-1]||'').trim())ins.push('');   /* 图片前后留空行，md 才认 */
    ins.push(md);
    if((lines[i]||'').trim())ins.push('');
    lines.splice(i,0,...ins);
  }
  editor.value=lines.join('\n');
  lastSnap=editor.value;
  stat();renderOutline();setUnsaved();
  if(document.body.classList.contains('preview')){
    renderPreview();
    const url=(md.match(/\(([^)\s]+)\)/)||[])[1]||'';
    const fig=[...prevPane.querySelectorAll('.fig')].find(f=>{
      const im=f.querySelector('img');return im&&im.getAttribute('src')===url;});
    if(fig)fig.scrollIntoView({block:'center'});
  }else{
    autoGrow();
    const pos=editor.value.indexOf(md);
    editor.focus();
    if(pos>=0)editor.setSelectionRange(pos+md.length,pos+md.length);
  }
}
function figMdOf(){
  const cap=(document.getElementById('figCaption').value||'参考图').replace(/[\]\n]/g,'');
  return '!['+cap+']('+pickSrc+')'+(pickPct&&pickPct!==90?'{w='+pickPct+'}':'');
}
function insertFig(){insertFigMd(figMdOf(),false);}
document.getElementById('figInsert').onclick=()=>{
  if(!pickSrc){showToast('请先选择或上传一张图片');return;}
  insertFigMd(figMdOf(),figReplaceMode);
  closeModals();
};
/* 图片右键菜单：源码模式下作用于光标所在行的图片语法 */
let curFig=null;   /* {ls,le,url}：图片语法所在源码行的范围与地址 */
const imgCtx=document.getElementById('imgCtx');
function hideImgCtx(){imgCtx.classList.remove('on');}
function imgRangeAtCursor(){
  const v=editor.value,s=editor.selectionStart;
  const ls=v.lastIndexOf('\n',s-1)+1;
  let le=v.indexOf('\n',s); if(le<0)le=v.length;
  const m=v.slice(ls,le).match(/!\[[^\]]*\]\(([^)\s]+)\)/);
  return m?{ls:ls,le:le,url:m[1]}:null;
}
function showImgCtx(x,y){
  imgCtx.style.left=Math.max(4,Math.min(x,innerWidth-imgCtx.offsetWidth-8))+'px';
  imgCtx.style.top=Math.max(4,Math.min(y,innerHeight-imgCtx.offsetHeight-8))+'px';
  imgCtx.classList.add('on');
}
editor.addEventListener('contextmenu',e=>{
  const r=imgRangeAtCursor();
  if(!r)return;                       /* 光标不在图片行上时不接管右键 */
  e.preventDefault();
  e.stopPropagation();   /* 不冒泡到 document，否则刚弹出就被「点别处收起」关掉 */
  editor.setSelectionRange(r.ls,r.le);
  curFig=r;
  figReplaceLine=editor.value.slice(0,r.ls).split('\n').length-1;
  showImgCtx(e.clientX,e.clientY);
});
/* 预览模式下直接右键图片也能换图 / 删除 */
prevPane.addEventListener('contextmenu',e=>{
  const fig=e.target&&e.target.closest?e.target.closest('.fig'):null;
  if(!fig)return;
  const i=+fig.getAttribute('data-line')||0;
  const rg=lineRangeByIdx(i);
  const m=(editor.value.slice(rg.ls,rg.le)||'').match(/!\[[^\]]*\]\(([^)\s]+)\)/);
  if(!m)return;
  e.preventDefault();
  e.stopPropagation();
  curFig={ls:rg.ls,le:rg.le,url:m[1]};
  figReplaceLine=i;
  showImgCtx(e.clientX,e.clientY);
});
imgCtx.querySelector('[data-ctx="rep"]').onclick=()=>{
  hideImgCtx();
  if(!curFig)return;
  pickSrc=curFig.url;
  document.getElementById('pickPrev').src=curFig.url;
  document.getElementById('pickPrev').alt='当前图片';
  document.querySelectorAll('.pick').forEach(x=>x.classList.remove('on'));
  openImgModal(true);
};
imgCtx.querySelector('[data-ctx="del"]').onclick=()=>{
  hideImgCtx();
  if(!curFig)return;
  const v=editor.value;
  undoStack.push(v);if(undoStack.length>60)undoStack.shift();redoStack=[];
  /* 连同该行一起删掉，并把留下的连续空行收敛成一个，避免段落之间空出一大块 */
  let head=v.slice(0,curFig.ls),tail=v.slice(curFig.le+1);
  head=head.replace(/\n{3,}$/,'\n\n');
  tail=tail.replace(/^\n+/,'');
  editor.value=head+tail;
  curFig=null;figReplaceLine=-1;lastSnap=editor.value;
  if(document.body.classList.contains('preview'))renderPreview();
  else{autoGrow();editor.focus();editor.setSelectionRange(editor.selectionStart,editor.selectionStart);}
  stat();renderOutline();setUnsaved();
};
document.addEventListener('click',e=>{if(!imgCtx.contains(e.target))hideImgCtx();});
document.addEventListener('scroll',hideImgCtx,true);
document.addEventListener('contextmenu',e=>{if(!imgCtx.contains(e.target))hideImgCtx();});

/* 预览区里直接拖图片右下角的手柄调大小：落到源码的 {w=百分比} 上 */
let figDrag=null;
prevPane.addEventListener('pointerdown',e=>{
  if(!e.target||!e.target.closest)return;
  const grip=e.target.closest('.grip');
  if(!grip)return;
  const fig=grip.closest('.fig');
  if(!fig)return;
  e.preventDefault();e.stopPropagation();
  const box=fig.querySelector('.fig-box');
  const avail=(prevPane.clientWidth||prevPane.getBoundingClientRect().width)||1;
  figDrag={fig:fig,x0:e.clientX,w0:box.getBoundingClientRect().width,avail:avail};
  fig.classList.add('dragging');
  prevPane.setAttribute('contenteditable','false');   /* 拖拽时别误选文字 */
});
window.addEventListener('pointermove',e=>{
  if(!figDrag)return;
  let w=Math.round((figDrag.w0+(e.clientX-figDrag.x0))/figDrag.avail*100);
  w=Math.max(20,Math.min(160,w));
  figDrag.fig.style.setProperty('--fig-w',w+'%');
  figDrag.fig.setAttribute('data-w',w);
});
window.addEventListener('pointerup',()=>{
  if(!figDrag)return;
  const fig=figDrag.fig;figDrag=null;
  fig.classList.remove('dragging');
  prevPane.setAttribute('contenteditable','true');
  syncPreviewToSource();
  lastSnap=editor.value;stat();setUnsaved();
});
/* 上传本地图片（压缩后插入，避免撑爆文档） */
const localImgInput=document.getElementById('localImgInput');
document.getElementById('uploadImgBtn').onclick=()=>localImgInput.click();
localImgInput.onchange=()=>{
  const f=localImgInput.files[0];
  if(!f)return;
  const insBtn=document.getElementById('figInsert');
  const prev=pickSrc;
  pickSrc='';                       /* 处理中先清空，避免抢在压缩完成前插入空地址 */
  if(insBtn)insBtn.disabled=true;
  showToast('正在压缩图片…');
  const done=()=>{if(insBtn)insBtn.disabled=false;localImgInput.value='';};
  const reader=new FileReader();
  reader.onload=ev=>{
    const img=new Image();
    img.onload=()=>{
      const MAX=1280;let w=img.width,h=img.height;
      if(w>MAX||h>MAX){const r=Math.min(MAX/w,MAX/h);w=Math.round(w*r);h=Math.round(h*r);}
      const cv=document.createElement('canvas');cv.width=w;cv.height=h;
      cv.getContext('2d').drawImage(img,0,0,w,h);
      pickSrc=cv.toDataURL('image/jpeg',0.82);
      document.getElementById('pickPrev').src=pickSrc;
      document.getElementById('pickPrev').alt=f.name;
      document.getElementById('figCaption').value='参考图 · '+f.name.replace(/\.[^.]+$/,'');
      document.querySelectorAll('.pick').forEach(x=>x.classList.remove('on'));
      done();
      showToast('图片已就绪，点「插入到剧本」');
    };
    img.onerror=()=>{pickSrc=prev;done();showToast('这张图片读不出来，换一张试试');};
    img.src=ev.target.result;
  };
  reader.onerror=()=>{pickSrc=prev;done();showToast('文件读取失败');};
  reader.readAsDataURL(f);
};

/* ═════════════ 导入 ═════════════ */
function openImport(){
  openModal('importModal');
  document.getElementById('pasteFallback').classList.remove('on');
  document.getElementById('pasteArea').value='';
}
document.getElementById('importBtn').onclick=openImport;
const fileInput=document.getElementById('fileInput');
/* 当前选中的解析格式（粘贴文本也按它来：md 原样，txt 自动转 Markdown） */
function selImportFmt(){
  const s=document.querySelector('#importModal .fmt-card.sel');
  return s&&s.getAttribute('data-fmt')==='txt'?'txt':'md';
}
/* 粘贴文本：先尝试读系统剪贴板，读不到就展开手动粘贴区兜底 */
async function pasteImport(){
  let txt='';
  try{
    if(!navigator.clipboard||!navigator.clipboard.readText)throw new Error('unsupported');
    txt=await navigator.clipboard.readText();
  }catch(e){txt='';}
  if(txt&&txt.trim()){importText(txt,'粘贴内容',selImportFmt());return;}
  const fb=document.getElementById('pasteFallback');
  fb.classList.add('on');
  const ta=document.getElementById('pasteArea');
  ta.value='';ta.focus();
  showToast('读不到剪贴板，请在这里手动粘贴');
}
/* 工具栏「粘贴文本」：复用导入卡片里的粘贴逻辑。读不到剪贴板时
   直接打开导入弹窗并展开手动粘贴区兜底（而不是把兜底藏在隐藏弹窗里）。 */
async function toolbarPaste(){
  let txt='';
  try{
    if(!navigator.clipboard||!navigator.clipboard.readText)throw new Error('unsupported');
    txt=await navigator.clipboard.readText();
  }catch(e){txt='';}
  if(txt&&txt.trim()){importText(txt,'粘贴内容',selImportFmt());return;}
  openImport();                       /* 兜底：先开导入弹窗（它会清掉 fallback 的 on） */
  const fb=document.getElementById('pasteFallback');
  fb.classList.add('on');            /* 再展开手动粘贴区 */
  const ta=document.getElementById('pasteArea');
  ta.value='';ta.focus();
  showToast('读不到剪贴板，请在这里手动粘贴');
}
document.getElementById('pasteBtn').onclick=toolbarPaste;
document.getElementById('pasteGo').onclick=()=>{
  const t=document.getElementById('pasteArea').value;
  if(!t.trim()){showToast('请先粘贴内容');return;}
  importText(t,'粘贴内容',selImportFmt());
};
/* 导入卡片：.txt/.md 高亮并调起文件选择；「粘贴文本」直接读剪贴板 */
document.querySelectorAll('#importModal .fmt-card').forEach(c=>c.onclick=()=>{
  if(c.getAttribute('data-fmt')==='paste'){pasteImport();return;}
  document.querySelectorAll('#importModal .fmt-card').forEach(x=>x.classList.toggle('sel',x===c));
  fileInput.click();
});
/* 导出卡片：仅高亮选择导出格式 */
document.querySelectorAll('#exportModal .fmt-card').forEach(c=>c.onclick=()=>{
  document.querySelectorAll('#exportModal .fmt-card').forEach(x=>x.classList.toggle('sel',x===c));
});
document.getElementById('pickFile').onclick=()=>fileInput.click();
const escHtml=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const escAttr=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const stripTags=h=>String(h==null?'':h).replace(/<[^>]*>/g,'');
const unesc=s=>String(s==null?'':s).replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&amp;/g,'&');
/* ── 行内 md：行内代码 / 图片 / 链接 / 加粗 / 斜体 / 删除线 / 高亮 ──
   代码与链接先「存起来」再还原，避免里面的 * _ 被当作强调符号吃掉 */
function inlineMd(s){
  const PH=[];
  const stash=h=>{PH.push(h);return '\u0000'+(PH.length-1)+'\u0000';};
  let t=escHtml(s);
  t=t.replace(/`([^`\n]+)`/g,(_,c)=>stash('<code>'+c+'</code>'));
  t=t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g,(_,c,u)=>
    stash('<img class="inline-img" src="'+escAttr(u)+'" alt="'+c+'">'));
  t=t.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g,(_,tx,u)=>
    stash('<a href="'+escAttr(u)+'" target="_blank" rel="noopener">'+tx+'</a>'));
  t=t.replace(/\*\*([^*\n]+)\*\*/g,'<strong>$1</strong>')
     .replace(/__([^_\n]+)__/g,'<strong>$1</strong>')
     .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g,'$1<em>$2</em>')
     .replace(/~~([^~\n]+)~~/g,'<del>$1</del>')
     .replace(/==([^=\n]+)==/g,'<mark>$1</mark>');
  return t.replace(/\u0000(\d+)\u0000/g,(_,i)=>PH[+i]||'');
}
/* txt：整段转成 md 源码（场景行 → ###，括注行 → >，其余为普通段落） */
function parseTXT(text){
  const lines=text.split(/\r\n|\r|\n/).map(s=>s.trim()).filter(Boolean);
  return lines.map(p=>{
    if(/^[-*_]{3,}$/.test(p))return '---'; // 分隔线保留为 md 分隔线
    if(/^\d+\s/.test(p)&&/(外景|内景|场景)/.test(p))return '### '+p;
    if(/^[（(]/.test(p))return '> '+p;
    return p;
  }).join('\n\n');
}
/* md → 排版后的 HTML（供「预览」渲染剧本样式使用） */
/* 单行 md → 预览块的类别与内容；null 表示该行是空行 */
function mdLineRender(line){
  if(!line)return null;
  if(/^[-*_]{3,}$/.test(line))return {cls:'hr',inner:''};
  /* 图片：![图注](地址) 后可跟 {w=百分比} 记录手动调过的宽度 */
  const im=line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)(?:\s*\{w=(\d+)\})?$/);
  if(im){const cap=escHtml(im[1]||'');
    return {cls:'fig',w:im[3]?+im[3]:0,
      inner:'<span class="fig-box"><img src="'+escHtml(im[2])+'" alt="'+cap+'">'+
        '<i class="grip" title="拖动调整大小"></i></span>'+
        (cap?'<figcaption>'+cap+'</figcaption>':'')};}
  const hm=line.match(/^(#{1,6})[\s　]*(.+?)(?:[\s　]+#*)?$/);
  if(hm){const lv=hm[1].length,t=inlineMd(hm[2].trim());
    return {cls:lv===1?'title':(lv===2?'act':(lv===3?'scene-hd':'h-minor')),lv:lv,inner:t};}
  /* 列表：- / * / + / 1. 1)  */
  const lm=line.match(/^(\s*)([-*+]|\d+[.)])[\s　]+(.*)$/);
  if(lm){
    const indent=Math.min(3,Math.floor(lm[1].replace(/\t/g,'  ').length/2));
    return {cls:'md-li'+(/^\d/.test(lm[2])?' md-oli':''),pfx:lm[2],indent:indent,inner:inlineMd(lm[3])};
  }
  if(/^\*\*.+\*\*$/.test(line))return {cls:'char',inner:inlineMd(line.replace(/^\*\*|\*\*$/g,''))};
  if(/^>\s/.test(line))return {cls:'paren',inner:inlineMd(line.replace(/^>\s*/,''))};
  if(/^[（(]/.test(line))return {cls:'paren',inner:inlineMd(line)};
  if(/^[A-Z一-龥]{2,4}$/.test(line))return {cls:'char',inner:inlineMd(line)};
  return {cls:'action',inner:inlineMd(line)};
}
/* md → 预览 HTML：每个块用 data-line 记住它来自源码第几行；
   空行同样生成占位块，保证 DOM 顺序与源码行序一一对应（编辑后才能精确回写） */
/* 表格：| 表头 | 表头 | + | --- | --- | → 一个整块（预览里不可编辑，回写原样） */
function mdTableHtml(rows,ln){
  const cells=r=>r.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
  const src=rows.join('\n');
  let h='<table class="md-tbl" data-line="'+ln+'" data-md="'+escAttr(src)+'" contenteditable="false"><thead><tr>';
  cells(rows[0]).forEach(c=>{h+='<th>'+inlineMd(c)+'</th>';});
  h+='</tr></thead>';
  if(rows.length>2){
    h+='<tbody>';
    rows.slice(2).forEach(r=>{const cs=cells(r);h+='<tr>';cs.forEach(c=>{h+='<td>'+inlineMd(c)+'</td>';});h+='</tr>';});
    h+='</tbody>';
  }
  return h+'</table>';
}
/* 代码块：``` 围栏之间的内容原样显示 */
function mdCodeHtml(seg,ln,closed){
  const src=seg.join('\n');
  const body=(closed?seg.slice(1,-1):seg.slice(1)).join('\n');
  return '<pre class="md-pre" data-line="'+ln+'" data-md="'+escAttr(src)+'" contenteditable="false"><code>'+
    escHtml(body)+'</code></pre>';
}
function mdToHtml(text){
  let raw=String(text||'').split(/\r\n|\r|\n/),off=0;
  if(raw[0]&&raw[0].trim()==='---'){
    const end=raw.indexOf('---',1);
    if(end>0){raw=raw.slice(end+1);off=end+1;}
  }
  let out='';let i=0;
  while(i<raw.length){
    const ln=i+off,rawLine=raw[i],t=rawLine.trim();
    /* 围栏代码块 */
    if(/^```/.test(t)){
      let j=i+1;
      while(j<raw.length&&!/^```/.test(raw[j].trim()))j++;
      const closed=j<raw.length;
      out+=mdCodeHtml(raw.slice(i,closed?j+1:raw.length),ln,closed);
      i=closed?j+1:raw.length;
      continue;
    }
    /* 表格：本行以 | 开头，下一行是 |---|---| 分隔行 */
    if(/^\|/.test(t)&&i+1<raw.length&&raw[i+1].indexOf('-')>-1&&
       /^\|[\s:|-]*-[\s:|-]*\|?$/.test(raw[i+1].trim())){
      let j=i;
      while(j<raw.length&&/^\|/.test(raw[j].trim()))j++;
      out+=mdTableHtml(raw.slice(i,j),ln);
      i=j;
      continue;
    }
    const r=mdLineRender(t);
    if(r===null){out+='<p class="action" data-line="'+ln+'" data-blank="1"></p>';i++;continue;}
    if(r.cls==='hr'){out+='<hr data-line="'+ln+'">';i++;continue;}
    if(r.cls==='fig'){
      out+='<figure class="fig" data-line="'+ln+'"'+(r.w?' data-w="'+r.w+'" style="--fig-w:'+r.w+'%"':'')+'>'+r.inner+'</figure>';
      i++;continue;
    }
    /* data-md 记住完整原始源码行（含缩进）：这一行没被改动过就原样回写，行内语法不会丢 */
    const plain=unesc(stripTags(r.inner)).trim();
    const ind=r.pfx?(rawLine.match(/^[ \t　]*/)||[''])[0]:'';
    let attr='';
    if(plain!==t||r.pfx||rawLine!==t)
      attr+=' data-md="'+escAttr(rawLine)+'" data-txt="'+escAttr(plain)+'"';
    if(r.pfx)attr+=' data-pfx="'+escAttr(r.pfx)+'"';
    if(ind)attr+=' data-ind="'+escAttr(ind)+'"';
    if(r.lv)attr+=' data-lv="'+r.lv+'"';
    if(r.indent)attr+=' style="--li-indent:'+r.indent+'"';
    const tag=r.cls==='action'?'p':'div';
    out+='<'+tag+' class="'+r.cls+'" data-line="'+ln+'"'+attr+'>'+r.inner+'</'+tag+'>';
    i++;
  }
  return out;
}
/* frontmatter 解析：剥离 --- key: value --- 头部，返回 {meta, body}；与后端 parseFront 同逻辑 */
function parseFront(text){
  const lines=String(text).split(/\r\n|\r|\n/);
  const meta={};let bodyStart=0;
  if(lines[0]&&lines[0].trim()==='---'){
    for(let i=1;i<lines.length;i++){
      if(lines[i].trim()==='---'){bodyStart=i+1;break;}
      const m=lines[i].match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if(m){let v=m[2].trim();
        if(v==='true')v=true;else if(v==='false')v=false;
        else if(/^-?\d+(\.\d+)?$/.test(v))v=Number(v);
        else v=v.replace(/^['"]|['"]$/g,'');
        meta[m[1]]=v;}
    }
  }
  return {meta,body:lines.slice(bodyStart).join('\n')};
}
function importText(text,fname,fmt){
  const n=(fname||'').toLowerCase();
  if(!fmt){
    if(n.endsWith('.md')||n.endsWith('.markdown'))fmt='md';
    else fmt='txt';
  }
  /* md 以源码原样进入编辑区（frontmatter 交给后端存元信息）；txt 先转成 md */
  const md = fmt==='md' ? parseFront(text).body.replace(/^\s+|\s+$/g,'') : parseTXT(text);
  undoStack.push(editor.value);
  if(undoStack.length>60)undoStack.shift();
  redoStack=[];
  editor.value=md;
  lastSnap=editor.value;
  closeModals();show('data');autoGrow();stat();renderOutline();setUnsaved();
  if(document.body.classList.contains('preview'))renderPreview();
}
document.getElementById('doImport').onclick=()=>{
  const f=fileInput.files[0];
  const st=document.getElementById('importState');
  if(!f){st.style.display='block';st.textContent='请先选择要导入的文件';return;}
  const reader=new FileReader();
  reader.onload=()=>{const s=document.querySelector('#importModal .fmt-card.sel');importText(String(reader.result),f.name,s?s.getAttribute('data-fmt'):null);};
  reader.readAsText(f,'utf-8');};
fileInput.onchange=()=>{
  const st=document.getElementById('importState');
  st.style.display='block';st.textContent='✓ 已选择「'+(fileInput.files[0]?fileInput.files[0].name:'文件')+'」，点击开始导入';};
/* 拖拽导入 */
const dropzone=document.querySelector('.dropzone');
['dragover','dragenter'].forEach(ev=>dropzone.addEventListener(ev,e=>{
  e.preventDefault();dropzone.style.borderColor='var(--accent)';}));
['dragleave','drop'].forEach(ev=>dropzone.addEventListener(ev,e=>{
  e.preventDefault();dropzone.style.borderColor='';}));
dropzone.addEventListener('drop',e=>{
  const f=e.dataTransfer&&e.dataTransfer.files&&e.dataTransfer.files[0];
  if(!f)return;
  const st=document.getElementById('importState');
  st.style.display='block';st.textContent='✓ 已选择「'+f.name+'」，点击开始导入';
  const reader=new FileReader();
  reader.onload=()=>{const s=document.querySelector('#importModal .fmt-card.sel');importText(String(reader.result),f.name,s?s.getAttribute('data-fmt'):null);};
  reader.readAsText(f,'utf-8');});

/* ═════════════ 导出（txt / md） ═════════════ */
let toastEl=null,toastTimer=null;
function showToast(msg){
  if(!toastEl){toastEl=document.createElement('div');
    toastEl.className='toast';
    toastEl.style.cssText='position:fixed;left:50%;top:64px;transform:translateX(-50%);background:var(--ink-1);color:var(--bg);font-size:12px;padding:7px 16px;border-radius:999px;z-index:60;box-shadow:var(--shadow-pop);opacity:.95';
    document.body.appendChild(toastEl);}
  toastEl.textContent=msg;
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>{if(toastEl){toastEl.remove();toastEl=null;}},1600);
}
function escXml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
/* 源码模式：编辑区里就是 md 原文，无需再做 HTML→md 转换，天然保真 */
function toMarkdown(){return editor.value||'';}
/* md → 纯文本（导出 txt 时去掉标记符号） */
function mdToPlain(md){
  return String(md||'')
    .replace(/^\s*#{1,6}\s+/gm,'')
    .replace(/\*\*(.+?)\*\*/g,'$1')
    .replace(/^\s*>\s?/gm,'')
    .replace(/!\[[^\]]*\]\([^)]*\)(?:\s*\{w=\d+\})?/g,'')
    .replace(/\[([^\]]*)\]\([^)]*\)/g,'$1');
}
document.getElementById('exportBtn').onclick=()=>openModal('exportModal');
document.getElementById('doExport').onclick=()=>{
  const card=document.querySelector('#exportModal .fmt-card.sel');
  if(!card){showToast('请先选择导出格式');return;}
  const fmt=card.dataset.fmt,name=docName(curDoc)||'剧本';
  let content='',ext='',mime='';
  if(fmt==='txt'){content=mdToPlain(toMarkdown()).trim();ext='.txt';mime='text/plain';}
  else if(fmt==='md'){content=toMarkdown();ext='.md';mime='text/markdown';}
  const blob=new Blob([content],{type:mime+';charset=utf-8'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download=name+ext;
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(a.href),2000);
  closeModals();
  showToast('已导出「'+name+ext+'」，文件在下载目录中');
};

/* ═════════════ 备份包：导出 / 导入（全部剧本） ═════════════ */
function exportBackup(){
  if(typeof JSZip==='undefined'){showToast('备份组件未加载（需联网）');return;}
  apiFetch('/api/backup').then(r=>{
    if(!r.ok)throw new Error('http '+r.status);
    return r.json();
  }).then(async data=>{
    const zip=new JSZip();
    const docs=data&&data.docs||{};
    /* 人类可读的 .md 副本（按显示名命名，方便直接查看）；真正的还原靠下面的结构化 JSON */
    for(const identity of Object.keys(docs)){
      const d=docs[identity];
      if(d&&d.md!=null)zip.file(docName(identity)+'.md',d.md);
    }
    /* 结构化备份：含身份串（显示名§id）与分组，导入时原样还原，同名跨组也不丢 */
    zip.file('mujian-backup.json',JSON.stringify({exportedAt:data.exportedAt,docs:docs,groups:data.groups}));
    const blob=await zip.generateAsync({type:'blob'});
    const a=document.createElement('a');
    const d=new Date(),p=n=>String(n).padStart(2,'0');
    a.href=URL.createObjectURL(blob);
    a.download='幕间备份-'+d.getFullYear()+p(d.getMonth()+1)+p(d.getDate())+'-'+p(d.getHours())+p(d.getMinutes())+'.zip';
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),3000);
    showToast('备份包已导出（'+Object.keys(docs).length+' 个剧本）');
  }).catch(()=>showToast('导出失败，请稍后再试'));
}
function importBackupFile(f){
  if(typeof JSZip==='undefined'){showToast('备份组件未加载（需联网）');return;}
  const reader=new FileReader();
  reader.onload=async()=>{
    let zip;
    try{zip=await JSZip.loadAsync(reader.result);}catch(e){showToast('备份文件格式不正确');return;}
    /* 优先用结构化备份还原（保留 id 与分组，同名跨组不丢） */
    const bk=zip.file('mujian-backup.json');
    if(bk){
      if(!window.confirm('将导入备份包（含全部剧本与分组），是否继续？'))return;
      try{
        const j=JSON.parse(await bk.async('string'));
        const r=await apiFetch('/api/backup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(j)});
        if(!r.ok)throw new Error('http '+r.status);
        showToast('已导入备份（'+Object.keys(j.docs||{}).length+' 个剧本）');
        setTimeout(()=>location.reload(),700);
        return;
      }catch(e){showToast('结构化导入失败，改试用兼容模式');}
    }
    /* 兼容旧备份：逐文件导入（按显示名落盘，不参与分组归位） */
    const entries=zip.file(/\.md$/i);
    if(!entries||!entries.length){showToast('备份包内没有 .md 文件');return;}
    if(!window.confirm('将导入 '+entries.length+' 个剧本，同名会被覆盖，是否继续？'))return;
    let ok=0;
    for(const entry of entries){
      const disp=entry.name.replace(/\.md$/i,'');
      const identity=docIdentity(disp,newDocId());   // 旧备份无 id，新生成一个
      const text=await entry.async('string');
      try{
        const r=await apiFetch('/api/doc/'+encodeURIComponent(identity),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({md:text})});
        if(r.ok)ok++;
      }catch(e){}
    }
    showToast('已导入 '+ok+' 个剧本');
    setTimeout(()=>location.reload(),700);
  };
  reader.readAsArrayBuffer(f);
}
const backupFileInput=document.createElement('input');
backupFileInput.id='backupFileInput';
backupFileInput.type='file';
backupFileInput.accept='.zip,application/zip';
backupFileInput.style.display='none';
backupFileInput.onchange=()=>{
  const f=backupFileInput.files[0];
  backupFileInput.value='';
  if(f)importBackupFile(f);
};
document.body.appendChild(backupFileInput);
document.getElementById('backupExportBtn').onclick=exportBackup;
document.getElementById('backupImportBtn').onclick=()=>backupFileInput.click();

/* ═════════════ 保存 / 未保存状态（后端持久化） ═════════════ */
let dirty=false,autoTimer=null,curDoc=null;
async function saveCurrentDoc(silent){
  if(!curDoc)return true;
  /* 空内容不保存：防止后端无文件时加载到空编辑器，静默覆盖已有剧本 */
  if(!(editor.value||'').trim()){if(!silent)setSaved();return true;}
  const payload={
    md:editor.value
  };
  try{
    const r=await apiFetch('/api/doc/'+encodeURIComponent(curDoc),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    if(!r.ok)throw new Error('http '+r.status);
    /* 服务端回它自己写下的时间戳，本地照抄而不是用本机时间：
       两边的 updated 是同一把尺子，同步时的先后比较才作数 */
    let at=null;
    try{const j=await r.json();at=j&&j.updated;}catch(e){}
    await localPutDoc({name:curDoc,md:composeDocMd(editor.value,at),updated:at,groupId:gidOf(curDoc)});
    syncOffline=false;clearPending();
    scheduleSync(4000);       /* 存上服务器就等于「推给云端」，顺手在后台跟一次 */
    if(!silent)setSaved();
    return true;
  }catch(e){
    /* 存不上服务器（断网 / 服务没起）不代表白写：整篇落到浏览器本地，
       状态栏明说存在哪儿，联网后点一下同步再推上去 */
    const now=new Date().toISOString();
    try{await localPutDoc({name:curDoc,md:composeDocMd(editor.value,now),updated:now,groupId:gidOf(curDoc)});}catch(e2){}
    syncOffline=true;markPending();
    if(!silent){
      dirty=true;
      setSaveState('已存本地','var(--warn-ink)');
    }
    return false;
  }
}
/* 保存状态那一小块文案 + 颜色，集中一处改，免得几处各写一半漂了 */
function setSaveState(text,color){
  const t=document.getElementById('saveText');
  if(t)t.textContent=text;
  const s=document.getElementById('saveState');
  if(s)s.style.color=color||'';
}
function setUnsaved(){
  if(!dirty){dirty=true;
  setSaveState('未保存','var(--warn-ink)');}
  clearTimeout(autoTimer);autoTimer=setTimeout(()=>saveCurrentDoc(false),3000);}
function setSaved(){
  dirty=false;const d=new Date();
  setSaveState('已保存 · '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'));
  const rev=document.getElementById('statRev');
  if(rev)rev.textContent=(parseInt(rev.textContent)||0)+1;}
document.getElementById('saveState').onclick=()=>saveCurrentDoc(false);
document.addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();saveCurrentDoc(false);}});
/* 兜底：改完东西不到 3 秒就刷新/关页面，自动保存还没来得及跑，
   这里用 sendBeacon 把最后一版补发出去（不阻塞页面卸载）。
   顺带往浏览器本地留一份 —— sendBeacon 也可能发不出去（离线），
   本地那份才是这次的最后防线。 */
window.addEventListener('beforeunload',()=>{
  if(!dirty||!curDoc||!(editor.value||'').trim())return;
  const body=JSON.stringify({md:editor.value});
  try{navigator.sendBeacon(apiUrl('/api/doc/'+encodeURIComponent(curDoc)),
    new Blob([body],{type:'application/json'}));}catch(e){}
  /* 关页面时来不及等回调，这里用本机时间戳顶一下（下一次打开点同步会以云端时间为准） */
  try{
    const rec={name:curDoc,groupId:gidOf(curDoc),updated:new Date().toISOString(),
      md:composeDocMd(editor.value,null)};
    if(rec.md)rec.md=rec.md.replace('updated: null','updated: '+rec.updated);
    if(idb&&!idbFail){const t=idb.transaction('docs','readwrite');t.objectStore('docs').put(rec);}
  }catch(e){}
});

/* ═════════════ 预览：把 md 源码渲染成剧本排版样式 ═════════════ */
const prevBtn=document.getElementById('previewBtn');
function renderPreview(){prevPane.innerHTML=mdToHtml(editor.value||'');}
/* 内联 HTML → md：在预览里改了带加粗/代码/链接的段落时，行内标记不至于被抹平 */
function inlineHtmlToMd(html){
  let h=String(html||'').replace(/<br\s*\/?>/gi,'');
  h=h.replace(/<img\b[^>]*>/gi,function(tag){
      const s=(tag.match(/src="([^"]*)"/)||[])[1],a=(tag.match(/alt="([^"]*)"/)||[])[1];
      return s?('!['+(a||'')+']('+unesc(s)+')'):'';})
   .replace(/<code>([\s\S]*?)<\/code>/gi,'`$1`')
   .replace(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,'[$2]($1)')
   .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi,'**$2**')
   .replace(/<(em|i)>([\s\S]*?)<\/\1>/gi,'*$2*')
   .replace(/<del>([\s\S]*?)<\/del>/gi,'~~$1~~')
   .replace(/<mark>([\s\S]*?)<\/mark>/gi,'==$1==')
   .replace(/<[^>]*>/g,'');
  return unesc(h);
}
/* 预览块 → 一行 md 源码 */
function blockToMdLine(el){
  if(el.tagName==='HR')return '---';
  const md0=el.getAttribute('data-md');
  /* 表格 / 代码块：预览里不可编辑，整块原样回写 */
  if(el.getAttribute('contenteditable')==='false'&&md0!==null)return md0;
  const cls=(el.className||'').split(/\s+/);   /* 精确匹配：避免 action 被误判成 act */
  if(cls.includes('fig')){
    const img=el.querySelector('img'),cap=el.querySelector('figcaption');
    const url=img?img.getAttribute('src'):'';
    if(!url)return null;
    const w=parseInt(el.getAttribute('data-w')||'0',10);
    /* 只有跟默认值 90% 不一样才写进源码，保持 md 干净 */
    return '!['+(cap?cap.textContent:'')+']('+url+')'+(w&&w!==90?'{w='+w+'}':'');
  }
  const plain=(el.textContent||'').replace(/\u00a0/g,' ').trim();
  if(!plain)return null;
  /* 这一行没被改过（纯文本仍等于渲染时的纯文本）→ 直接用原始源码行，保留行内语法 */
  if(md0!==null){
    const dt=el.getAttribute('data-txt');
    if(dt!==null&&plain===dt)return md0;
  }
  /* 改过了：块里还留着行内标记就把它们还原成 md，别把加粗/代码/链接抹掉 */
  let t=plain;
  const inner=el.innerHTML||'';
  if(/<(strong|b|em|i|del|mark|code|a|img)\b/i.test(inner)){
    const s=inlineHtmlToMd(inner).trim();
    if(s)t=s;
  }
  if(cls.includes('title'))return '# '+t;
  else if(cls.includes('act'))return '## '+t;
  else if(cls.includes('scene-hd'))return '### '+t;
  else if(cls.includes('h-minor'))return '######'.slice(0,(+el.getAttribute('data-lv')||4))+' '+t;
  else if(cls.includes('char'))return '**'+t+'**';
  else if(cls.includes('paren'))return '> '+t;
  else if(cls.includes('md-li'))return (el.getAttribute('data-ind')||'')+(el.getAttribute('data-pfx')||'- ')+' '+t;
  return t;
}
/* 预览区编辑 → 回写 md 源码：按 DOM 顺序重建，未改动的块沿用原行，不做整篇重新格式化 */
function syncPreviewToSource(){
  const out=[];
  [...prevPane.children].forEach(el=>{
    if(el.tagName==='BR')return;
    if(el.hasAttribute('data-blank')&&!(el.textContent||'').trim()){out.push('');return;}
    const md=blockToMdLine(el);
    if(md!==null)out.push(md);
  });
  const nv=out.join('\n');
  if(nv===editor.value)return false;
  editor.value=nv;
  return true;
}
/* 在预览区直接编辑：改动即时写回源码，源码侧的字号/大纲/保存状态同步刷新 */
prevPane.addEventListener('input',()=>{
  renumberPreview();                 /* 回车新增/删除块后重排行号，大纲定位才准 */
  if(syncPreviewToSource())lastSnap=editor.value;
  stat();renderOutline();setUnsaved();scheduleHistory();
});
function enterPreview(){
  renderPreview();
  document.body.classList.add('preview');
  editor.hidden=true;prevPane.hidden=false;prevPane.scrollTop=0;
  document.getElementById('previewLabel').textContent='查看源码';
  if(!IS_TOUCH)prevPane.focus();   /* 手机上别一进预览就抢焦点弹键盘，点了再编辑 */
}
function exitPreview(){
  syncPreviewToSource();                 /* 切回源码前先把改动落回 */
  document.body.classList.remove('preview');
  editor.hidden=false;prevPane.hidden=true;
  document.getElementById('previewLabel').textContent='预览';
  editor.focus();autoGrow();
}
prevBtn.onclick=()=>{
  /* 只有点按钮才算「你选的视图」，记下来；加载文档时的自动进入不算 */
  if(document.body.classList.contains('preview')){prefSet(PREF.mode,'source');exitPreview();}
  else{prefSet(PREF.mode,'preview');enterPreview();}
};
/* 你上次停在哪种视图：preview / source / ''（没选过→按内容自动决定） */
function prefMode(){const m=prefGet(PREF.mode,'');return m==='preview'||m==='source'?m:'';}
/* ═════════════ 显示比例（状态栏 +/-） ═════════════
   只改「看」的大小：稿纸宽度、字号、页边距一起按倍率缩放，不写进稿子文件。
   稿子自己的字号归工具栏 A-/A+ 管，那个会存进文档、跟着稿子走。
   这里用 CSS 变量整体缩放而不是 transform:scale —— scale 只是把画好的东西
   拉大，稿纸高度不会跟着变，底下就会糊成一团、还盖住后面的内容。 */
let zoom=100;
function setZoom(v,save){
  zoom=Math.max(50,Math.min(200,Math.round(v/10)*10));
  document.documentElement.style.setProperty('--view-zoom',(zoom/100).toFixed(2));
  document.getElementById('zoomVal').textContent=zoom+'%';
  autoGrow();                      /* 字号变了，源码框的高度得重新量一遍 */
  if(save!==false)prefSet(PREF.zoom,zoom);
}
/* 开页时套上上次的比例（boot.js 已经先套过一次，这里再同步一下百分比显示） */
function initZoom(){setZoom(parseInt(prefGet(PREF.zoom,''),10)||100,false);}
document.getElementById('zoomIn').onclick=()=>setZoom(zoom+10);
document.getElementById('zoomOut').onclick=()=>setZoom(zoom-10);
/* 点一下百分比：回到 100% */
const zoomValEl=document.getElementById('zoomVal');
zoomValEl.title='显示比例 · 点击回到 100%';
zoomValEl.style.cursor='pointer';
zoomValEl.onclick=()=>setZoom(100);

/* 大纲点击定位（高亮当前场景） */
document.querySelectorAll('.scene').forEach(s=>s.onclick=()=>{
  document.querySelectorAll('.scene').forEach(x=>x.classList.toggle('on',x===s));});

/* ═════════════ 撤销 / 重做（真实历史栈） ═════════════ */
let undoStack=[],redoStack=[],lastSnap=editor.value,histTimer=null;
function recordHistory(){
  if(lastSnap!==editor.value){
    undoStack.push(lastSnap);
    if(undoStack.length>60)undoStack.shift();
    redoStack=[];
    lastSnap=editor.value;
  }
}
function scheduleHistory(){clearTimeout(histTimer);histTimer=setTimeout(recordHistory,600);}
function applySnap(snap){
  lastSnap=snap;editor.value=snap;
  if(document.body.classList.contains('preview'))renderPreview();
  else autoGrow();
  stat();renderOutline();setUnsaved();
}
document.getElementById('undo').onclick=()=>{
  if(!undoStack.length){showToast('没有可撤销的操作');return;}
  redoStack.push(lastSnap);
  applySnap(undoStack.pop());showToast('已撤销');
};
document.getElementById('redo').onclick=()=>{
  if(!redoStack.length){showToast('没有可重做的操作');return;}
  undoStack.push(lastSnap);
  applySnap(redoStack.pop());showToast('已重做');
};

/* ═════════════ 本地副本 · 同步 ═════════════
   本地 = 浏览器里的一份完整镜象（IndexedDB），云端 = 服务器 data/ 目录。
   本地是主存储：读写先落地本地，离线也能开能写；云端在后台自动跟上。
   点同步时两边逐篇比「改到几点」，新的那份胜出；一边删了另一边也跟着删。
   同步引擎（runSync）既手动可点，也会在保存成功 / 重新聚焦 / 断网恢复时自动跑。

   为什么不直接用 localStorage：剧本文本上万字，localStorage 只有 5MB 且是同步
   阻塞写入，存两篇大稿就写不动了。IndexedDB 容量按磁盘走、写入不卡界面。 */
const SYNC_STORE='mujian_mirror';
let syncPending=false;      /* 本地有还没推上去的改动 */
let syncOffline=false;      /* 连不上服务器（改动都留在本地，不会丢） */

/* ── 存取层：IndexedDB 为主，隐私模式等打不开时退回 localStorage ── */
let idb=null,idbFail=false;
function openIDB(){
  if(idb)return Promise.resolve(idb);
  if(idbFail)return Promise.resolve(null);
  return new Promise(res=>{
    let req;
    try{req=indexedDB.open(SYNC_STORE,1);}catch(e){idbFail=true;return res(null);}
    req.onupgradeneeded=()=>{
      const db=req.result;
      if(!db.objectStoreNames.contains('docs'))db.createObjectStore('docs',{keyPath:'name'});
      if(!db.objectStoreNames.contains('deleted'))db.createObjectStore('deleted',{keyPath:'name'});
    };
    req.onsuccess=()=>{idb=req.result;res(idb);};
    /* 无痕模式 / 被策略禁用：不报错，静默降级 */
    req.onerror=()=>{idbFail=true;res(null);};
    req.onblocked=()=>{idbFail=true;res(null);};
  });
}
const LS_DOC='mujian_ls_doc_',LS_DEL='mujian_ls_del_',LS_KEY='mujian_ls_names';
function lsNames(prefix){
  try{return JSON.parse(localStorage.getItem(LS_KEY)||'{}')[prefix]||[];}catch(e){return [];}
}
function lsAdd(prefix,name){
  try{
    const m=JSON.parse(localStorage.getItem(LS_KEY)||'{}');
    const arr=m[prefix]||[];
    if(!arr.includes(name))arr.push(name);
    m[prefix]=arr;localStorage.setItem(LS_KEY,JSON.stringify(m));
  }catch(e){}
}
function lsDrop(prefix,name){
  try{
    const m=JSON.parse(localStorage.getItem(LS_KEY)||'{}');
    m[prefix]=(m[prefix]||[]).filter(n=>n!==name);
    localStorage.setItem(LS_KEY,JSON.stringify(m));
  }catch(e){}
}
function tx(db,store,mode){
  const t=db.transaction(store,mode);
  return {t,os:t.objectStore(store)};
}
function idle(t){return new Promise((res,rej)=>{t.oncomplete=()=>res();t.onerror=()=>rej(t.error);t.onabort=()=>rej(t.error);});}
const wrap=req=>new Promise((res,rej)=>{req.onsuccess=()=>res(req.result);req.onerror=()=>rej(req.error);});
const toLs=rec=>record_to_ls(rec);          /* 仅用于降级路径，见下 */
function record_to_ls(rec){return {name:rec.name,md:rec.md,updated:rec.updated};}

/* 一条本地记录：{name, md, updated, groupId, deletedAt}
   被删的稿子不直接抹掉，而是留下 deletedAt —— 不然「本地删了」和「本地没有」
   长得一模一样，云端那份就又会被拉回来。 */
async function localPutDoc(rec){
  const db=await openIDB();
  if(!db){
    try{localStorage.setItem(LS_DOC+rec.name,JSON.stringify(rec));lsAdd('d',rec.name);
      localStorage.removeItem(LS_DEL+rec.name);lsDrop('x',rec.name);}catch(e){}
    return;
  }
  const {t,os}=tx(db,'docs','readwrite');
  os.put(rec);
  const d=tx(db,'deleted','readwrite');d.os.delete(rec.name);
  await Promise.all([idle(t),idle(d.t)]);
}
async function localGetDoc(name){
  const db=await openIDB();
  if(!db){
    try{const s=localStorage.getItem(LS_DOC+name);return s?JSON.parse(s):null;}catch(e){return null;}
  }
  const {os}=tx(db,'docs','readonly');
  return (await wrap(os.get(name)))||null;
}
async function localAllDocs(){
  const db=await openIDB();
  if(!db){
    const out={};
    for(const n of lsNames('d')){
      try{const s=localStorage.getItem(LS_DOC+n);if(s)out[n]=JSON.parse(s);}catch(e){}
    }
    return out;
  }
  const {os}=tx(db,'docs','readonly');
  const arr=(await wrap(os.getAll()))||[];
  const out={};arr.forEach(r=>{out[r.name]=r;});
  return out;
}
/* 墓碑单独一张表，查「这出戏是不是本机删的」不用把正文都读出来 */
async function localMarkDeleted(name,at){
  const db=await openIDB();
  if(!db){
    try{localStorage.setItem(LS_DEL+name,at);lsAdd('x',name);
      localStorage.removeItem(LS_DOC+name);lsDrop('d',name);}catch(e){}
    return;
  }
  const d=tx(db,'deleted','readwrite');d.os.put({name,deletedAt:at});
  const s=tx(db,'docs','readwrite');s.os.delete(name);
  await Promise.all([idle(d.t),idle(s.t)]);
}
async function localGetDeleted(name){
  const db=await openIDB();
  if(!db){try{return localStorage.getItem(LS_DEL+name)||null;}catch(e){return null;}}
  const {os}=tx(db,'deleted','readonly');
  const r=await wrap(os.get(name));
  return r?r.deletedAt:null;
}
async function localAllDeleted(){
  const db=await openIDB();
  if(!db){
    const out={};
    for(const n of lsNames('x')){try{out[n]=localStorage.getItem(LS_DEL+n)||'';}catch(e){}}
    return out;
  }
  const {os}=tx(db,'deleted','readonly');
  const arr=(await wrap(os.getAll()))||[];
  const out={};arr.forEach(r=>{out[r.name]=r.deletedAt;});
  return out;
}
async function localClearDeleted(names){
  const db=await openIDB();
  for(const n of names){
    if(!db){try{localStorage.removeItem(LS_DEL+n);lsDrop('x',n);}catch(e){}continue;}
    const {t,os}=tx(db,'deleted','readwrite');os.delete(n);
    await idle(t);
  }
}
/* 改名：本地记录与墓碑都跟着换名字，否则同步时会把它当成「删了一篇 + 新增一篇」 */
async function localRename(from,to){
  const rec=await localGetDoc(from);
  if(rec)await localPutDoc(Object.assign({},rec,{name:to}));
  const delAt=await localGetDeleted(from);
  if(delAt)await localMarkDeleted(to,delAt);
  const db=await openIDB();
  if(!db){
    try{localStorage.removeItem(LS_DOC+from);lsDrop('d',from);
      localStorage.removeItem(LS_DEL+from);lsDrop('x',from);}catch(e){}
    return;
  }
  const a=tx(db,'docs','readwrite');a.os.delete(from);
  const b=tx(db,'deleted','readwrite');b.os.delete(from);
  await Promise.all([idle(a.t),idle(b.t)]);
}

/* 本地镜象必须和云端文件长得一模一样：服务端 writeDoc 只拼 updated / name
   两项（背景色 / 字体 / 字号 / 预览排版都是全局偏好，存在 localStorage，不进文件头），
   这里按同一份配方拼，保证本地推上去时不被服务端当成「缺字段」而重置。 */
function composeDocMd(body,updated){
  return ['---','updated: '+updated,'---',''].join('\n')+(body||'');
}
/* 从一份 md（带 frontmatter）里抠出 updated，给本地镜象对齐云端时间用 */
function updatedOfMd(md){const m=parseFront(md||'').meta;return m.updated||null;}
/* ── 角标：本地有没推上去的改动 / 连不上服务器 ── */
function syncChrome(){
  const dot=document.getElementById('syncDot');
  if(!dot)return;
  dot.hidden=!(syncPending||syncOffline);
  dot.classList.toggle('off',syncOffline);
  dot.title=syncOffline?'没连上服务器，改动都留在本地':'有改动还没同步到云端';
}
function markPending(){if(!syncPending){syncPending=true;syncChrome();}}
function clearPending(){if(syncPending){syncPending=false;syncChrome();}}

/* ═════════════ 手动同步：本机服务器 ⇄ 云端服务器 ═════════════
   本机 = 打开这份程序的服务器（同源那份 data/，所有正常读写都打它）；
   云端 = 设置里填的地址，只在这里对账，是份会自动跟上的镜像。
   判定只有一条规则：同一篇稿子，谁的 updated 晚谁算数；删除靠墓碑区分。 */
let syncing=false,lastAutoSyncAt=0,syncFailStreak=0,syncBackoffUntil=0;
function td(ms){return Math.floor(Number(ms||0)/1000/60);}   /* 分钟粒度，够用且不啰嗦 */
/* 浏览器本地镜象（IndexedDB）始终是「本机服务器」的一份离线副本：
   把本机服务器当前状态整体垫进来，断网时也能开、且和本机文件一致。 */
async function localDelDoc(n){
  const db=await openIDB();
  if(!db){try{localStorage.removeItem(LS_DOC+n);lsDrop('d',n);}catch(e){}return;}
  const {t,os}=tx(db,'docs','readwrite');os.delete(n);await idle(t);
}
async function mirrorLocalFromServer(){
  const r=await apiFetch('/api/sync');if(!r.ok)return;
  const d=await r.json();
  const docs=(d&&d.docs)||{},del=(d&&d.deleted)||{};
  const all=await localAllDocs();
  for(const n of Object.keys(all)){
    if(n in docs||n in del)continue;     /* 还在 / 被删的下面会处理 */
    await localDelDoc(n);                 /* 本机已没有也没删 → 清掉镜象里残留的 */
  }
  for(const n of Object.keys(docs)){
    await localPutDoc({name:n,md:docs[n].md,updated:docs[n].updated,groupId:gidOf(n)});
  }
  for(const n of Object.keys(del)){await localMarkDeleted(n,new Date(del[n]).toISOString());}
}
/* 同步后按本机服务器的最新列表重建左侧剧本清单 */
async function rebuildListFromLocal(){
  try{
    const r=await apiFetch('/api/docs');
    if(r.ok){const d=await r.json();DOC_ORDER=(d.docs||[]).map(x=>x.name);}
  }catch(e){}
  await loadGroups();renderTabs();renderLibrary();updateChrome();
  if(curDoc&&!OPEN_TABS.includes(curDoc)){OPEN_TABS.push(curDoc);appendTab(curDoc);}
  /* 同步后只刷新列表 UI，不重 load 当前文档 —— 否则会打断正在进行的编辑、把滚动位置顶到头，
     还顺手清空了撤销栈。当前文档若被云端改了，在 runSync ① 里已经单独 loadDoc 过。 */
  if(curDoc)show('data'); else show('empty');
}
async function runSync(){
  /* 先把编辑器里还没落盘的东西存进本机，否则刚敲的几句会漏在同步之外。
     这里必须用非静默保存（silent=false）：静默版成功后不结算 dirty，
     于是每次同步都会以为还有没存的东西，白往云端多写一版。 */
  if(dirty)await saveCurrentDoc(false);
  if(syncing)return;
  const addr=cloudBase();
  if(!addr){
    /* 没设云端地址：纯本机模式，只把浏览器镜象对齐本机服务器 */
    try{await mirrorLocalFromServer();syncOffline=false;clearPending();}
    catch(e){syncOffline=true;markPending();}
    return;
  }
  syncing=true;
  const btn=document.getElementById('syncBtn');
  if(btn)btn.classList.add('busy');
  const report={up:0,down:0,delUp:0,delDown:0,skip:0,fail:0,groupsUp:0,groupsDown:0};
  try{
    /* 同时拉两边的全量（正文 + 修改时间 + 墓碑），在客户端逐篇比时间 */
    const [lr,cr,lgR,cgR]=await Promise.all([apiFetch('/api/sync'),cloudFetch('/api/sync'),apiFetch('/api/groups'),cloudFetch('/api/groups')]);
    if(!lr.ok)throw new Error('本机服务器连不上（http '+lr.status+'）');
    if(cr.status===401)throw new Error('云端口令不对');
    if(!cr.ok)throw new Error('云端连不上（http '+cr.status+'）');
    if(cgR.status===401)throw new Error('云端口令不对');
    const L=await lr.json(),C=await cr.json();
    const LG=lgR.ok?await lgR.json():null;          /* 组结构：本地一定有，云端可能没有（旧版服务端 / 没填地址） */
    const CG=cgR.ok?await cgR.json():null;
    const lDocs=(L&&L.docs)||{},lDel=(L&&L.deleted)||{};
    const cDocs=(C&&C.docs)||{},cDel=(C&&C.deleted)||{};

    /* ① 两端都有 → 比时间，新的推到旧的那端（l 新推云端，c 新拉回本机） */
    for(const name of Object.keys(lDocs)){
      if(!(name in cDocs))continue;
      const lt=Date.parse(lDocs[name].updated||'')||0,ct=Date.parse(cDocs[name].updated||'')||0;
      if(lt>ct){
        try{const rr=await cloudFetch('/api/doc/'+encodeURIComponent(name),{method:'POST',
          headers:{'Content-Type':'application/json'},body:JSON.stringify({md:lDocs[name].md||''})});
          if(!rr.ok)throw 0;报告(report,'up',name,lt-ct);}catch(e){report.fail++;}
      }else if(ct>lt){
        try{const rr=await apiFetch('/api/doc/'+encodeURIComponent(name),{method:'POST',
          headers:{'Content-Type':'application/json'},body:JSON.stringify({md:cDocs[name].md||''})});
          if(!rr.ok)throw 0;
          await localPutDoc({name,md:cDocs[name].md,updated:cDocs[name].updated,groupId:gidOf(name)});
          报告(report,'down',name,ct-lt);if(curDoc===name)await loadDoc(name);}catch(e){report.fail++;}
      }else report.skip++;
    }

    /* ② 仅本机有（文件还在）→ 把正文推到云端 */
    for(const name of Object.keys(lDocs)){
      if(name in cDocs)continue;
      try{const rr=await cloudFetch('/api/doc/'+encodeURIComponent(name),{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({md:lDocs[name].md||''})});
        if(!rr.ok)throw 0;report.up++;}catch(e){report.fail++;}
    }

    /* ②b 本机删了（文件已不在本地、墓碑还在）→ 把「删除」也推到云端，并清掉本机墓碑。
       放在 ② 之后单独成步，逻辑才清楚：删文件走这里，改内容走 ②。 */
    const pushedDel=[];
    for(const name of Object.keys(lDel)){
      if(name in lDocs)continue;          // 文件还在本地：交给 ①② 处理
      if(!(name in cDocs))continue;       // 云端也没有了：无需处理
      const dt=Date.parse(lDel[name])||0,ct=Date.parse(cDocs[name].updated||'')||0;
      if(dt>=ct){
        try{const rr=await cloudFetch('/api/doc/'+encodeURIComponent(name),{method:'DELETE'});if(!rr.ok)throw 0;
          report.delUp++;pushedDel.push(name);delete cDocs[name];}catch(e){report.fail++;}
      }
    }
    if(pushedDel.length){
      try{await apiFetch('/api/deleted',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({names:pushedDel})});}catch(e){}
      try{await localClearDeleted(pushedDel);}catch(e){}
    }

    /* ③ 仅云端有 → 拉回本机（本机删过的情况已在 ②b 处理：删得晚就连带云端一起删） */
    for(const name of Object.keys(cDocs)){
      if(name in lDocs)continue;
      try{const rr=await apiFetch('/api/doc/'+encodeURIComponent(name),{method:'POST',
        headers:{'Content-Type':'application/json'},body:JSON.stringify({md:cDocs[name].md||''})});
        if(!rr.ok)throw 0;
        await localPutDoc({name,md:cDocs[name].md,updated:cDocs[name].updated,groupId:gidOf(name)});
        report.down++;}catch(e){report.fail++;}
    }

    /* ④ 云端删了、本机还在 → 本机也删（前提是本机那份不比墓碑新），并留本机墓碑 */
    for(const name of Object.keys(cDel)){
      if(!(name in lDocs))continue;
      const dt=Date.parse(cDel[name])||0;
      if((Date.parse(lDocs[name].updated||'')||0)>dt){report.skip++;continue;}
      try{const rr=await apiFetch('/api/doc/'+encodeURIComponent(name),{method:'DELETE'});if(!rr.ok)throw 0;
        await localMarkDeleted(name,new Date(dt).toISOString());report.delDown++;
        if(curDoc===name)curDoc=DOC_ORDER.find(n=>n!==name)||null;}catch(e){report.fail++;}
    }

    /* ⑤ 组结构（.groups.json：组定义 + 剧本归属）两端比时间、较新者胜。
       组目录（data/<组文件夹>/）由本机服务器的 writeGroups 在收到新组结构后自动重建，
       剧本 .md 文件已在上面的 ①②③ 同步到位，所以只传 .groups.json 即可两边一致。 */
    let groupsChanged=false;
    if(LG&&CG){
      const lu=Date.parse((LG.updated)||'')||0, cu=Date.parse((CG.updated)||'')||0;
      try{
        if(lu>cu){
          const rr=await cloudFetch('/api/groups',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({groups:LG.groups,docs:LG.docs,updated:LG.updated})});
          if(!rr.ok)throw 0; report.groupsUp++;
        }else if(cu>lu){
          const rr=await apiFetch('/api/groups',{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({groups:CG.groups,docs:CG.docs,updated:CG.updated})});
          if(!rr.ok)throw 0; groupsChanged=true; report.groupsDown++;
        }else report.skip++;
      }catch(e){ report.fail++; }
    }

    syncOffline=false;clearPending();
    await mirrorLocalFromServer();   /* 把本机服务器最新状态垫回浏览器镜象 */
    if(report.fail>0)showToast('同步失败：'+report.fail+' 篇没传上去，其余已处理，改动都还在本机');
    /* 有增删 / 换内容 → 按本机最新列表重画 */
    if(report.up||report.down||report.delUp||report.delDown||groupsChanged){
      await rebuildListFromLocal();
    }
    if(btn)btn.classList.remove('fail');
    /* 同步成功：清掉失败退避计数，记一下时间（供自动同步限速用） */
    syncFailStreak=0;syncBackoffUntil=0;lastAutoSyncAt=Date.now();
  }catch(e){
    /* 同步失败不该让人以为稿子没了 —— 本机那份一笔没动，只是没对上云端 */
    syncOffline=true;markPending();
    /* 失败退避：连不上时自动重试越等越久，避免切窗口 / 点按钮就空转重试；
       想立刻重试点一下 ⟳ 即可（手动同步不受退避限制） */
    syncFailStreak++;
    syncBackoffUntil=Date.now()+Math.min(SYNC_BACKOFF_BASE*Math.pow(2,syncFailStreak-1),SYNC_BACKOFF_MAX);
    if(btn)btn.classList.add('fail');
    showToast('同步失败：'+(e&&e.message||'连不上')+'，改动都还在本机');
  }finally{
    syncing=false;
    if(btn)setTimeout(()=>btn.classList.remove('busy'),200);
    syncChrome();
  }
}
function 报告(rep,kind,name,delta){
  rep[kind]++;
  console.log('[同步] '+kind+' '+name+' ('+td(delta)+'分钟)');
}
const syncBtnEl=document.getElementById('syncBtn');
if(syncBtnEl){
  syncBtnEl.onclick=()=>runSync();
  /* 右键 = 改云端地址。左键是同步，这个入口藏二级，平时不占地方 */
  syncBtnEl.addEventListener('contextmenu',e=>{e.preventDefault();openCloudSet();});
  syncBtnEl.title='同步到云端';
}

/* ═════════════ 自动同步：本地为主存储，云端在后台跟上 ═════════════
   手动点同步按钮永远都在（见上）。这里再挂几个「顺手推」的时机：
   保存成功、窗口重新聚焦、断网恢复、页面重新可见。
   只有「确实有没对上的改动 / 离线过」时才真正跑，省得聚焦就空转。

   优化（2026-09-15）：自动同步加了「最短间隔 + 失败退避」，防止
   - 切窗口 / 点几个按钮就立刻触发；
   - 云端连不上时每次聚焦都重试、刷屏似地空转。
   手动点 ⟳ 永远立即执行，不受这些限制。 */
const MIN_AUTO_SYNC_MS=30000;     // 两次自动同步之间至少隔 30 秒
const SYNC_BACKOFF_BASE=15000;    // 失败后下一次自动重试的基础等待（15s）
const SYNC_BACKOFF_MAX=300000;    // 退避上限 5 分钟
let autoSyncTimer=null;
function scheduleSync(delay){
  if(autoSyncTimer)clearTimeout(autoSyncTimer);
  /* 算出真正要等多久：请求的 delay、失败退避到期、最短间隔结束，取最大但封顶 2 分钟 */
  const now=Date.now();
  let wait=delay||4000;
  if(now<syncBackoffUntil)wait=Math.max(wait,syncBackoffUntil-now);
  const coolEnd=lastAutoSyncAt+MIN_AUTO_SYNC_MS;
  if(now<coolEnd && (syncOffline||dirty))wait=Math.max(wait,coolEnd-now);
  autoSyncTimer=setTimeout(()=>{
    autoSyncTimer=null;
    if(syncing||document.hidden)return;          // 正跑着或切到后台，这次先不跑
    const t=Date.now();
    /* 最短间隔内、又没有紧急改动（离线 / 没存的编辑）→ 直接放弃这次自动触发 */
    if(t-lastAutoSyncAt<MIN_AUTO_SYNC_MS && !(syncOffline||dirty))return;
    /* 失败退避未到 → 推迟到退避结束再试，不空转 */
    if(t<syncBackoffUntil){scheduleSync(Math.max(1,syncBackoffUntil-t));return;}
    lastAutoSyncAt=t;
    runSync();
  }, Math.min(wait,120000));
}
window.addEventListener('online',()=>scheduleSync(800));
window.addEventListener('focus',()=>{ if(syncPending||syncOffline)scheduleSync(2500); });
document.addEventListener('visibilitychange',()=>{ if(!document.hidden&&(syncPending||syncOffline))scheduleSync(2500); });

/* 同步内部状态：给自动化测试用的观察窗口，不影响正常使用 */
window.__SYNC__={
  run:runSync,
  state:()=>({pending:syncPending,offline:syncOffline,syncing}),
  localAll:localAllDocs,
  localDeleted:localAllDeleted,
  localPut:localPutDoc,
  localMarkDeleted,
  backend:()=>openIDB().then(db=>db?'indexeddb':'localstorage')
};

/* ═════════════ 关键屏声明 ═════════════ */
window.__UI_CAPTURE__={
  reset:async()=>{
    setTheme('paper',false);
    document.body.classList.remove('preview');
    document.getElementById('previewLabel').textContent='预览';
    prevBtn.style.borderColor='';
    setScriptSize(16,false);setLayout(false);setZoom(100,false);
    closeModals();closePop();closeFontPop();
    editor.style.fontFamily='';
    document.querySelectorAll('.font-item').forEach(x=>x.classList.toggle('on',x.dataset.font==='yahei'));
    editor.value='';autoGrow();if(document.body.classList.contains('preview'))exitPreview();stat();renderOutline();
    document.getElementById('saveText').textContent='已保存';
    document.getElementById('saveState').style.color='';
    document.getElementById('statRev').textContent='0';
    DOC_ORDER=[];OPEN_TABS=[];INIT_DOCS=null;curDoc=null;
    GDATA={groups:[],docs:{}};selGroup=null;
    prefDel(PREF.tabs);prefDel(PREF.cur);prefDel(PREF.font);prefDel(PREF.size);prefDel(PREF.zoom);prefDel(PREF.outline);
    syncPending=false;syncOffline=false;syncChrome();
    const sb=document.getElementById('syncBtn');if(sb)sb.classList.remove('busy','fail');
    renderTabs();renderLibrary();updateChrome();
    document.querySelector('.outline').classList.remove('collapsed');
    document.querySelector('.library').classList.remove('grow');
    show('empty');
  },
  states:[
    {id:'data',    label:'编辑态', go:async()=>{}},
    {id:'theme',   label:'深墨主题', go:async()=>{setTheme('ink',false);}},
    {id:'fontsize',label:'字号放大', go:async()=>{setScriptSize(21);}},
    {id:'layout',  label:'自动排版', go:async()=>{setLayout(true);}},
    {id:'replace', label:'搜索替换', go:async()=>{
        const nm='稿子';
        await fetch('/api/doc/'+encodeURIComponent(nm),{method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({md:'# 稿子\n\n先是第一个关键词，接着第二个关键词。\n'})});
        await window.switchDoc(nm);
        openSearchPanel();
        findInputEl.value='关键词';
        runFind();}},
    {id:'insert',  label:'插入图片', go:async()=>{
        pickPct=118;insertFig();
        stat();}},
    {id:'empty',   label:'空状态',  go:async()=>show('empty')},
    {id:'loading', label:'加载态',  go:async()=>show('loading')},
    {id:'error',   label:'异常态',  go:async()=>show('error')}
  ]};

/* ═════════════ 剧本元素：点击插入对应类型段落 ═════════════ */
let activeType=null;
const fmtBtns=[...document.querySelectorAll('.fbtn')];
function highlightFmt(){fmtBtns.forEach(b=>b.classList.toggle('on',b.dataset.type===activeType));}
/* 剧本元素按钮 → 在当前行写入对应的 md 标记 */
/* 画面用「- 」开头（源码里带横杠，预览里是带标记的条目），对白保持纯文本，
   两者一眼就能分开；就像「(&#8203;)」那样一眼能分辨 */
const TYPE_PREFIX={title:'# ',act:'## ','scene-hd':'### ',paren:'> ',char:'**',action:'- ',dialogue:''};
/* 预览模式下按钮改的是块 class，回写源码时由 blockToMdLine 再变回 md 标记 */
const TYPE_CLASS={title:'title',act:'act','scene-hd':'scene-hd',paren:'paren',char:'char',action:'md-li',dialogue:'action'};
function currentLineRange(){
  const v=editor.value,s=editor.selectionStart;
  const ls=v.lastIndexOf('\n',s-1)+1;
  let le=v.indexOf('\n',s); if(le<0)le=v.length;
  return [ls,le];
}
function setLineMark(mark){
  const v=editor.value,[ls,le]=currentLineRange();
  const line=v.slice(ls,le);
  /* 先剥掉已有的标题/引用/加粗/列表标记，再套上新标记，避免叠加成「- - 文字」 */
  const bare=line.replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/,'')
                 .replace(/^\*\*(.+)\*\*$/,(_,a)=>a);
  let nl;
  if(mark==='**')nl='**'+(bare.trim()||'角色名')+'**';
  else nl=mark+bare;
  editor.value=v.slice(0,ls)+nl+v.slice(le);autoGrow();
  const p=ls+nl.length;
  editor.setSelectionRange(p,p);
  editor.focus();
}
/* ── 预览模式下就地改类型：不切回源码，光标留在块里接着打字 ── */
function previewBlockAtCaret(){
  const s=document.getSelection();
  if(!s||!s.anchorNode)return null;
  let n=s.anchorNode;
  if(n.nodeType===3)n=n.parentNode;
  while(n&&n.parentNode!==prevPane)n=n.parentNode;
  return (n&&n.parentNode===prevPane)?n:null;
}
function newBlankBlock(after){
  const p=document.createElement('p');
  p.className='action';p.setAttribute('data-blank','1');
  if(after&&after.nextSibling)prevPane.insertBefore(p,after.nextSibling);
  else prevPane.appendChild(p);
  return p;
}
/* 块增删后重排行号，保证 data-line 与源码行序一致（大纲定位依赖它） */
function renumberPreview(){[...prevPane.children].forEach((el,i)=>el.setAttribute('data-line',i));}
function setPreviewBlockType(type){
  let el=previewBlockAtCaret();
  if(el&&(el.tagName==='HR'||el.classList.contains('fig')))el=newBlankBlock(el); /* 分隔线/图片不能被改成文字类型 */
  if(!el){
    const last=prevPane.lastElementChild;   /* 焦点不在预览区时：复用末尾空行，否则追加一行 */
    el=(last&&last.hasAttribute('data-blank')&&!(last.textContent||'').trim())?last:newBlankBlock(null);
  }
  const cls=TYPE_CLASS[type]||'action';
  /* 类型换了，原来那行源码的缓存就作废：不清掉的话回写时会照旧原样吐出来，
     等于「改了类型却没写进源码」 */
  el.removeAttribute('data-md');el.removeAttribute('data-txt');
  if(cls==='md-li'){el.setAttribute('data-pfx','-');el.removeAttribute('data-ind');}
  else{el.removeAttribute('data-pfx');el.removeAttribute('data-ind');}
  if(!(el.textContent||'').trim()){
    el.innerHTML='';                        /* 清空内容，让 :empty 的占位提示生效 */
    el.className=cls;
    el.setAttribute('data-blank','1');      /* 空块仍占一行，未输入前回写为空行 */
  }else{
    el.className=cls;
    el.removeAttribute('data-blank');
  }
  renumberPreview();
  syncPreviewToSource();
  const r=document.createRange();r.selectNodeContents(el);r.collapse(false);
  const s=document.getSelection();s.removeAllRanges();s.addRange(r);
  prevPane.focus();
}
function insertBlock(type){
  undoStack.push(editor.value);
  if(undoStack.length>60)undoStack.shift();
  redoStack=[];
  if(document.body.classList.contains('preview'))setPreviewBlockType(type);
  else setLineMark(TYPE_PREFIX[type]!==undefined?TYPE_PREFIX[type]:'');
  activeType=type;highlightFmt();
  lastSnap=editor.value;
  stat();renderOutline();setUnsaved();
}
fmtBtns.forEach(btn=>{
  btn.addEventListener('mousedown',e=>e.preventDefault());   /* 别让按钮抢走预览区光标 */
  btn.onclick=()=>{
    const t=btn.dataset.type;
    if(activeType===t){activeType=null;highlightFmt();return;} /* 再次点击取消选中 */
    insertBlock(t);
  };
});

/* ═════════════ 初始渲染：从后端同步剧本列表 ═════════════ */
document.getElementById('authBtn').onclick=function(){
  const key=document.getElementById('authInput').value.trim();
  const err=document.getElementById('authErr');
  if(!key){if(err)err.textContent='请输入访问口令';return;}
  localStorage.setItem(AUTH_KEY,key);
  /* 先拿口令换服务端下发的认证 Cookie，再刷新回首页：
     有了 Cookie，/app.js、/app.css 等静态资源才会被正常放行，界面才能完整渲染 */
  fetch('/api/auth?key='+encodeURIComponent(key)).then(function(r){
    if(r.ok)location.href='/';
    else{localStorage.removeItem(AUTH_KEY);if(err)err.textContent='口令不正确，请重新输入';}
  }).catch(function(){if(err)err.textContent='网络错误，请重试';});
};
document.getElementById('authInput').addEventListener('keydown',e=>{
  if(e.key==='Enter')document.getElementById('authBtn').click();
});

/* ═════════════ 云端设置：数据存哪台机器 ═════════════
   本机跑程序时默认是存本机；想让数据落到自己那台服务器（多设备共用一份、
   或者不想让稿子跟这台电脑绑死），就在这儿填地址。 */
const cloudModal=document.getElementById('cloudModal');
const cloudTip=document.getElementById('cloudTip');
function openCloudSet(){
  closePop();closeFontPop();openModal('cloudModal');
  const u=document.getElementById('cloudUrl');
  const k=document.getElementById('cloudKey');
  let cur='';try{cur=localStorage.getItem(CLOUD_BASE_KEY)||'';}catch(e){}
  if(u)u.value=cur;
  if(k)k.value=(localStorage.getItem(CLOUD_KEY)||'');
  cloudTip.className='ctip';
  cloudTip.textContent=cur?('云端同步地址：'+cur):'云端同步地址：未设置（只存本机，不同步）';
  setTimeout(()=>{if(u)u.focus();},50);
}
document.getElementById('cloudCancel').onclick=closeModals;
document.getElementById('cloudReset').onclick=()=>{
  try{localStorage.removeItem(CLOUD_BASE_KEY);localStorage.removeItem(CLOUD_KEY);}catch(e){}
  closeModals();location.reload();
};
document.getElementById('cloudSave').onclick=async()=>{
  const u=document.getElementById('cloudUrl'),k=document.getElementById('cloudKey');
  let addr=(u.value||'').trim().replace(/\/+$/,'');
  const btn=document.getElementById('cloudSave');
  if(!addr){
    /* 留空 = 关掉云端同步，纯本机 */
    try{localStorage.removeItem(CLOUD_BASE_KEY);localStorage.removeItem(CLOUD_KEY);}catch(e){}
    closeModals();location.reload();return;
  }
  if(!/^https?:\/\//i.test(addr)){
    /* 只写域名或 IP 时补个协议，省得猜错 */
    addr=(/^(localhost|127\.|\[::1\]|[0-9.]+)(:\d+)?$/i.test(addr)?'http://':'https://')+addr;
  }
  cloudTip.className='ctip';cloudTip.textContent='正在连接…';
  btn.disabled=true;
  try{
    const r=await fetch(addr+'/api/docs?key='+encodeURIComponent((k.value||'').trim()),
      {mode:'cors',cache:'no-store'});
    if(r.status===401){
      cloudTip.className='ctip bad';
      cloudTip.textContent='服务器要口令，口令不对（也可能是没填）';
      btn.disabled=false;return;
    }
    if(!r.ok)throw new Error('http '+r.status);
    const d=await r.json();
    try{localStorage.setItem(CLOUD_BASE_KEY,addr);localStorage.setItem(CLOUD_KEY,(k.value||'').trim());}catch(e){}
    cloudTip.className='ctip good';
    cloudTip.textContent='连上了，云端有 '+(d.docs||[]).length+' 篇剧本，正在同步…';
    setTimeout(()=>location.reload(),600);
  }catch(e){
    cloudTip.className='ctip bad';
    cloudTip.textContent='连不上这个地址：'+(e&&e.message||'')+
      '。检查一下服务器是否开着、端口对不对、页面是 https 时服务器也得是 https。';
    btn.disabled=false;
  }
};
document.getElementById('cloudUrl').addEventListener('keydown',e=>{
  if(e.key==='Enter')document.getElementById('cloudSave').click();
});
document.getElementById('cloudKey').addEventListener('keydown',e=>{
  if(e.key==='Enter')document.getElementById('cloudSave').click();
});
/* 预加载字体，避免切换文档/字体时文字回退闪烁 */
if(document.fonts&&document.fonts.load){
  (async()=>{try{await Promise.all(Object.values(FONTS).map(f=>document.fonts.load('16px '+f)));}catch(e){}})();
}
/* ═════════════ 移动端：侧栏抽屉开关 ═════════════ */
function closeNav(){const a=document.querySelector('.app');if(a)a.classList.remove('nav-open');}
const navToggle=document.getElementById('navToggle');
const sideBackdrop=document.getElementById('sideBackdrop');
if(navToggle)navToggle.addEventListener('click',()=>{const a=document.querySelector('.app');a.classList.toggle('nav-open');});
if(sideBackdrop)sideBackdrop.addEventListener('click',closeNav);

(async function init(){
  let remote=null,seeded=false,authFail=false;
  try{
    const r=await apiFetch('/api/docs');
    if(r.ok){const d=await r.json();remote=d.docs||[];seeded=!!d.seeded;}
  }catch(e){if(e&&e.message==='auth required')authFail=true;}
  if(authFail){showAuthGate();return;}
  if(remote===null){
    /* 连不上服务器（离线 / 服务没起）：用浏览器本地镜象撑起列表，照样能开能写 */
    const ld=await localAllDocs();
    DOC_ORDER=Object.keys(ld);
    syncOffline=true;
    const ws=restoreWorkspace();
    OPEN_TABS=ws.tabs;curDoc=ws.cur;
  }else if(remote&&remote.length){
    /* 云端已有数据：以服务器文件为准，窗口/当前文档从本地偏好恢复 */
    DOC_ORDER=remote.map(x=>x.name);
    const ws=restoreWorkspace();
    OPEN_TABS=ws.tabs;
    curDoc=ws.cur;
  }else{
    /* 后端为空（首次使用或已删光）：一律显示空态，不内置任何演示剧本 */
    DOC_ORDER=[];OPEN_TABS=[];curDoc=null;
    prefDel(PREF.tabs);prefDel(PREF.cur);
  }
  await loadGroups();
  initZoom();                     /* 恢复上次的显示比例（视觉上 boot.js 已先套好） */
  /* 恢复上次的大纲展开/折叠状态（折叠=1，缺省=展开） */
  setOutlineCollapsed(prefGet(PREF.outline,'0')==='1');
  /* 本地镜象是后加的：第一次打开时里面还是空的，先用本机服务器现状把它垫上，
     否则第一次同步会以为「本地什么都没有」，把删除之类的判断全算错 */
  try{
    const ld=await localAllDocs();
    if(!Object.keys(ld).length&&remote&&remote.length){
      const rr=await apiFetch('/api/sync');
      if(rr.ok){
        const cd=(await rr.json()).docs||{};
        for(const n of Object.keys(cd))await localPutDoc({name:n,md:cd[n].md,updated:cd[n].updated});
      }
    }
  }catch(e){/* 本地存不了（无痕模式等）不该拦住页面加载 */}
  syncChrome();
  /* 设了云端地址 → 进页面先对账一次，把云端的剧本拉进本机列表 */
  if(cloudBase())scheduleSync(1500);
  renderTabs();renderLibrary();updateChrome();
  if(curDoc){show('data');await loadDoc(curDoc);}else show('empty');
  document.body.classList.add('loaded');
})();
