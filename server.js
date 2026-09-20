/* 幕间 · 剧本写作工作台 —— 云服务器版后端（每剧本一个 .md 文件）
 * Node 原生 http，零依赖。
 * - 静态托管 console/ 目录（成品页，浏览器直接访问）
 * - API：文档列表 / 读取 / 保存 / 删除。每个剧本独立存为一个 .md 文件：
 *   文件名带显示名：data/<组文件夹?>/<显示名>_<id>.md（未分组的在 data/ 根）。
 *   剧本「显示名」存在每篇 frontmatter 的 name 字段，可与别的组/未分组剧本重名；
 *   <id> 后缀保证全局唯一（不同/同组同名也不会撞文件名）。
 *   对外身份串用 显示名§id（§=U+001F）表示，前端以此为主键；文件以 id 定位。
 *   frontmatter 存元数据 updated/name（背景色/字体/字号/预览排版均为全局偏好，不进文件头），正文为剧本 md
 * - 访问口令：设置环境变量 ACCESS_KEY 后开启鉴权（未设置时保持开放）
 * 启动：node server.js   （端口默认 8910，可用环境变量 PORT 覆盖）
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const CONSOLE = path.join(ROOT, 'console');
const DATA_DIR = path.join(ROOT, 'data');
const ORDER_FILE = path.join(DATA_DIR, '.order.txt');
const GROUPS_FILE = path.join(DATA_DIR, '.groups.json');
/* ── 删除墓碑：记「谁在什么时候被删了」 ──
   光靠文件在不在，是分不清「云端删了」和「云端从来没这出戏」的：
   前者要让本地也跟着删，后者却是要往上推的。所以删的时候留张纸条。 */
const TOMB_FILE = path.join(DATA_DIR, '.deleted.json');
const PORT = process.env.PORT || 8910;
const ACCESS_KEY = process.env.ACCESS_KEY || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/* ── 文档身份：对外身份串 = 显示名 § id（§ = U+001F 单元分隔符）──
   文件只认 id（<id>.md 落在所属组的文件夹里，未分组的在 data/ 根）。
   显示名存在每篇 frontmatter 的 name 字段，因此不同组 / 未分组的剧本可以同名。 */
const DOC_SEP = '\u001F';   // U+001F 单元分隔符，前后端必须一致
function parseDocId(s) {
  if (s == null) return null;
  const i = String(s).indexOf(DOC_SEP);
  return i < 0 ? null : String(s).slice(i + 1);
}
function docIdentity(display, id) { return String(display) + DOC_SEP + String(id); }
/* 一个 id 可能落在根目录或任一组文件夹里：全局唯一，递归找一遍。
   文件名形如 显示名_id.md（id 是末段下划线之后的部分），兼容旧版纯 <id>.md。 */
function docFileById(id) {
  if (!id) return null;
  /* 旧格式兜底：<id>.md（仅根目录） */
  const exact = path.join(DATA_DIR, safeName(id) + '.md');
  if (fs.existsSync(exact)) return exact;
  /* 扫一遍根目录与各组文件夹，按「末段 == id」匹配（兼容 显示名_id.md 与旧 <id>.md） */
  const dirs = [DATA_DIR];
  try {
    for (const e of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.')) dirs.push(path.join(DATA_DIR, e.name));
    }
  } catch (e) {}
  for (const dir of dirs) {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith('.md')) {
          const base = e.name.slice(0, -3);
          if (base.split('_').pop() === id) return path.join(dir, e.name);
        }
      }
    } catch (e2) {}
  }
  return null;
}
/* 取某 id 的显示名：优先 frontmatter 的 name，否则退回 id */
function docDisplayName(id) {
  const f = docFileById(id);
  if (!f) return id;
  try { const { meta } = parseFront(fs.readFileSync(f, 'utf8')); return meta.name != null ? String(meta.name) : id; }
  catch (e) { return id; }
}
/* 某 id 归属哪个组（.groups.json 的 docs 仍以身份串为 key，需按 id 反查） */
function docGroupOf(id) {
  const g = readGroups();
  if (!g || !g.docs) return '';
  for (const k of Object.keys(g.docs)) { if (parseDocId(k) === id) return g.docs[k]; }
  return '';
}

/* ── 数据层：每剧本一个 .md 文件，文件以稳定 id 命名 ──
   属于某组的，存 data/<组文件夹>/<id>.md；未分组的，留在 data/<id>.md。
   归属实时从 .groups.json 查，因此改名 / 移组 / 删组后，writeGroups 的 reconcile
   会把 <id>.md 搬到正确文件夹。显示名存在 frontmatter 的 name 字段。 */
function safeName(name) {
  return String(name).replace(/[\\/]/g, '_').replace(/\.\./g, '_').replace(/^\.+$/, '_');
}
/* id 所在文件夹：按归属组的 dir 定；未分组 / 找不到则落在 data/ 根 */
function docDirForId(id) {
  try {
    const gid = docGroupOf(id);
    if (gid) {
      const grp = readGroups().groups.find(x => x.id === gid);
      if (grp && grp.dir) return path.join(DATA_DIR, grp.dir);
    }
  } catch (e) {}
  return DATA_DIR;
}
/* 文档文件名：显示名_id.md（id 后缀保证全局唯一，不同/同组同名也不会撞文件名） */
function safeDocName(name) {
  const illegal = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|']);
  let s = String(name == null ? '' : name);
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code < 32 || illegal.has(ch)) out += '_';
    else out += ch;
  }
  while (out.indexOf('  ') >= 0) out = out.split('  ').join(' ');
  out = out.trim();
  while (out.length && out[0] === '_') out = out.slice(1);
  while (out.length && out[out.length - 1] === '_') out = out.slice(0, -1);
  if (out.length && out.split('').every(function (c) { return c === '.'; })) out = 'doc';
  if (!out) out = 'doc';
  return out.slice(0, 80);
}
function docFileName(id, dispName) { return safeDocName(dispName != null ? String(dispName) : id) + '_' + id + '.md'; }
function docFilePathFor(id, dispName) { return path.join(docDirForId(id), docFileName(id, dispName)); }
/* 递归收集 data/ 下所有 .md（组的子文件夹也算），跳过隐藏文件/目录（.order.txt 等） */
function walkMd(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(full, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(full);
  }
}
/* 解析 YAML 风格 frontmatter：--- key: value --- 之后为正文；对 true/false/数字做类型还原 */
function parseFront(text) {
  const lines = String(text).split(/\r\n|\r|\n/);
  const meta = {}; let bodyStart = 0;
  if (lines[0] && lines[0].trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') { bodyStart = i + 1; break; }
      const m = lines[i].match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (m) {
        let v = m[2].trim();
        if (v === 'true') v = true;
        else if (v === 'false') v = false;
        else if (/^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
        else v = v.replace(/^['"]|['"]$/g, '');
        meta[m[1]] = v;
      }
    }
  }
  return { meta, body: lines.slice(bodyStart).join('\n') };
}
function listDocs() {
  const out = [];
  const files = [];
  walkMd(DATA_DIR, files);
  /* 按 id 去重（同一 id 不该出现在两个地方） */
  const seen = new Set();
  /* 一次性把 groups 读进来，建 id → gid 映射，避免每篇都重读文件 */
  const g = readGroups();
  const gidById = {};
  for (const k of Object.keys(g.docs || {})) { const id = parseDocId(k); if (id) gidById[id] = g.docs[k]; }
  for (const f of files) {
    const id = path.basename(f).slice(0, -3).split('_').pop();
    if (seen.has(id)) continue;
    let display;
    try { const { meta } = parseFront(fs.readFileSync(f, 'utf8')); display = meta.name != null ? String(meta.name) : id; }
    catch (e) { display = id; }
    seen.add(id);
    const identity = docIdentity(display, id);
    out.push({ name: identity, id, group: gidById[id] || '', updated: null });
  }
  /* 补上 updated：再读一遍 frontmatter 太贵，这里从文件 mtime 兜底（精确时间以保存时写入的 frontmatter 为准） */
  for (const it of out) {
    try { const { meta } = parseFront(fs.readFileSync(docFileById(it.id), 'utf8')); it.updated = meta.updated || null; }
    catch (e) {}
  }
  const order = readOrder();
  if (order && order.length) {
    const set = new Set(out.map(x => x.name));
    const ordered = order.filter(n => set.has(n)).map(n => out.find(x => x.name === n));
    const rest = out.filter(x => !order.includes(x.name));
    return ordered.concat(rest);
  }
  return out;
}
/* 顺序清单：持久化剧本在列表中的排列顺序（纯文本，每行一个） */
function readOrder() {
  try { return fs.readFileSync(ORDER_FILE, 'utf8').split(/\r\n|\r|\n/).map(s => s.trim()).filter(Boolean); }
  catch (e) { return []; }
}
function writeOrder(arr) {
  try { fs.writeFileSync(ORDER_FILE, arr.join('\n') + '\n', 'utf8'); return true; }
  catch (e) { return false; }
}
/* ── 分组：剧本可以归到「组」里，组始终排在未分组剧本前面 ──
   结构：{ _idv:1, groups:[{id,name,open,dir}], docs:{ 身份串(显示名§id): 组id } }
   docs 仍以「身份串」为 key（与前端保持一致），值仍是组 id；组内剧本按 id 落盘到 dir 文件夹。
   dir = 该组在 data/ 下的文件夹名（首次写入时按组名生成并持久化，改名时跟着重命名）。 */
function readGroups() {
  const empty = { groups: [], docs: {}, updated: null };
  try {
    const raw = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return empty;
    const groups = Array.isArray(raw.groups) ? raw.groups.filter(g => g && typeof g.id === 'string')
      .map(g => ({ id: g.id, name: String(g.name == null ? '新组' : g.name), open: g.open !== false,
                   dir: (typeof g.dir === 'string' && g.dir) ? g.dir : undefined })) : [];
    const docs = (raw.docs && typeof raw.docs === 'object') ? raw.docs : {};
    const ids = new Set(groups.map(g => g.id));
    const clean = {};
    for (const k of Object.keys(docs)) { if (ids.has(docs[k])) clean[k] = docs[k]; }
    return { groups, docs: clean, updated: (typeof raw.updated === 'string' ? raw.updated : null) };
  } catch (e) { return empty; }
}
/* 安全文件夹名：去非法字符 / 截断 / 不空；组重名由调用方加序号去重 */
function dirSafe(name) {
  let s = String(name == null ? 'group' : name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
  s = s.replace(/^_+|_+$/g, '').replace(/^\.+$/, '');
  if (!s) s = 'group';
  return s.slice(0, 50);
}
/* 把文件从 from 搬到 to（目录不存在就建）；搬不动就复制+删源兜底 */
function moveFileTo(from, to) {
  if (from === to || !fs.existsSync(from)) return;
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  } catch (e) {
    try { fs.copyFileSync(from, to); fs.unlinkSync(from); } catch (e2) {}
  }
}
/* 找剧本文件真实所在：根目录优先，其次任一组文件夹（用于把「历史遗留、放错位置」的文件搬回规范位置） */
function findDocAnywhere(name) {
  const safe = safeName(name);
  const root = path.join(DATA_DIR, safe + '.md');
  if (fs.existsSync(root)) return root;
  try {
    for (const e of fs.readdirSync(DATA_DIR, { withFileTypes: true })) {
      if (e.isDirectory() && !e.name.startsWith('.')) {
        const fp = path.join(DATA_DIR, e.name, safe + '.md');
        if (fs.existsSync(fp)) return fp;
      }
    }
  } catch (e) {}
  return null;
}
function writeGroups(data) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const old = readGroups();                        // 旧状态（含 dir、docs 映射）
    const oldDirById = {};
    for (const g of old.groups) if (g.dir) oldDirById[g.id] = g.dir;

    // 新组定义（校验过滤）
    const groups = Array.isArray(data && data.groups) ? data.groups.filter(g => g && typeof g.id === 'string')
      .map(g => ({ id: g.id, name: String(g.name == null ? '新组' : g.name).slice(0, 60), open: g.open !== false })) : [];
    const ids = new Set(groups.map(g => g.id));
    const docs = {};
    const src = (data && data.docs && typeof data.docs === 'object') ? data.docs : {};
    for (const k of Object.keys(src)) { if (ids.has(src[k])) docs[k] = src[k]; }

    // 1) 删除的组：成员剧本移回 data/ 根，删掉空文件夹（删组不删剧本）
    for (const og of old.groups) {
      if (!ids.has(og.id)) {
        const members = Object.keys(old.docs).filter(n => old.docs[n] === og.id);
        for (const n of members) {
          const id = parseDocId(n);
          const from = id ? docFileById(id) : null;
          if (from) moveFileTo(from, path.join(DATA_DIR, docFileName(id, docDisplayName(id))));
        }
        if (og.dir) {
          const d = path.join(DATA_DIR, og.dir);
          try { if (fs.readdirSync(d).length === 0) fs.rmdirSync(d); } catch (e) {}
        }
      }
    }

    // 2) 给每个组定文件夹名：沿用旧 dir，否则按组名生成；同名加序号；改名则重命名文件夹
    const used = new Set();
    const newDirById = {};
    for (const g of groups) {
      let dir = (typeof g.dir === 'string' && g.dir) ? g.dir : dirSafe(g.name);
      let base = dir, i = 2;
      while (used.has(base)) { base = dir + ' ' + i; i++; }
      used.add(base);
      const oldDir = oldDirById[g.id];
      if (oldDir && oldDir !== base) {
        const from = path.join(DATA_DIR, oldDir), to = path.join(DATA_DIR, base);
        if (fs.existsSync(from)) { try { fs.renameSync(from, to); } catch (e) {} }
      } else if (!fs.existsSync(path.join(DATA_DIR, base))) {
        try { fs.mkdirSync(path.join(DATA_DIR, base), { recursive: true }); } catch (e) {}
      }
      g.dir = base;
      newDirById[g.id] = base;
    }

    // 3) 把每篇剧本搬到它的「规范位置」（按当前归属）：新建组 → 搬进文件夹；移出组 → 搬回根；
    //    改名 → 文件夹跟着改名后文件已在位（no-op）；旧版根目录剧本 → 迁移进文件夹。已在位则为 no-op。
    //    用 docFileById 找到文件真实所在，避免「放错位置的历史文件」被当成不存在而漏搬。
    const allIdentities = new Set([...Object.keys(old.docs), ...Object.keys(docs)]);
    for (const k of allIdentities) {
      const id = parseDocId(k);
      if (!id) continue;
      const newGid = docs[k];
      const newDir = newGid ? (newDirById[newGid] || null) : null;
      const to = path.join(newDir ? path.join(DATA_DIR, newDir) : DATA_DIR, docFileName(id, docDisplayName(id)));
      const from = docFileById(id);
      moveFileTo(from, to);
    }

    // 4) 持久化（含 dir、迁移标记与同步时间戳 updated）
    /* updated 给跨服务端同步用：调用方显式传了（云端推送时带对端时间）就保留，避免两端来回互刷；
       否则用现在时间（本地改动 / 首次迁移 / 导入备份）。 */
    /* updated 给跨服务端同步用：调用方显式传了（云端推送时带对端时间）就保留，避免两端来回互刷；
       否则用现在时间（本地改动 / 首次迁移 / 导入备份）。启动时的 writeGroups(readGroups()) 会把已有
       updated 一并传进来，因此不会被每次重启刷成新时间。 */
    const updated = (data && typeof data.updated === 'string' && !isNaN(Date.parse(data.updated))) ? data.updated : new Date().toISOString();
    fs.writeFileSync(GROUPS_FILE, JSON.stringify({ _idv: 1, updated, groups, docs }, null, 2), 'utf8');
    return { groups, docs, updated };
  } catch (e) { return null; }
}
/* 墓碑读写：{ 剧本名: 删除时间 }。坏文件当成空，不让它拖垮别的接口 */
function readDeleted() {
  try {
    const raw = JSON.parse(fs.readFileSync(TOMB_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return {};
    const out = {};
    for (const k of Object.keys(raw)) if (typeof raw[k] === 'string') out[k] = raw[k];
    return out;
  } catch (e) { return {}; }
}
function writeDeleted(map) {
  try { fs.writeFileSync(TOMB_FILE, JSON.stringify(map, null, 2), 'utf8'); return true; }
  catch (e) { return false; }
}
function markDeleted(name, at) {
  const d = readDeleted();
  d[name] = at || new Date().toISOString();
  writeDeleted(d);
  return d[name];
}
function clearDeleted(name) {
  const d = readDeleted();
  if (d[name] == null) return false;
  delete d[name];
  writeDeleted(d);
  return true;
}
function readDocRaw(s) {
  const id = parseDocId(s) != null ? parseDocId(s) : s;   // 兼容身份串与裸 id
  const f = docFileById(id);
  try { return f ? fs.readFileSync(f, 'utf8') : null; } catch (e) { return null; }
}
function writeDoc(s, p) {
  const id = parseDocId(s) != null ? parseDocId(s) : s;   // 兼容身份串与裸 id
  const emb = p.md ? parseFront(p.md).meta : {};
  let dispName;
  if (p.name != null) dispName = String(p.name);
  else if (emb.name != null) dispName = String(emb.name);
  else { const i = String(s).indexOf(DOC_SEP); dispName = i < 0 ? id : String(s).slice(0, i); }
  const target = docFilePathFor(id, dispName);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const updated = new Date().toISOString();
  // 合并 md 自带的全部 frontmatter 键（保全 author 等自定义键），再用显式字段覆盖已知键
  const meta = Object.assign({}, emb, {
    updated
  });
  const body = p.md ? parseFront(p.md).body : '';
  /* 显示名已在上方计算：优先级 = 显式 name → md 内 name → 身份串里的显示名（避免保存把名字冲成 id） */
  const fm = ['---', 'updated: ' + meta.updated,
    'name: ' + JSON.stringify(dispName), '---', ''];
  fs.writeFileSync(target, fm.join('\n') + body, 'utf8');
  const order = readOrder();
  if (!order.includes(s)) { order.push(s); writeOrder(order); }
  clearDeleted(id);          /* 又写了回来：这出戏复活了，墓碑作废 */
  return meta;
}
/* 删除要返回删除时刻（给同步用）：本地镜象照抄这个时间，两边才不会再互相拉扯一遍 */
function delDoc(s) {
  const id = parseDocId(s) != null ? parseDocId(s) : s;
  const f = docFileById(id);
  if (f) {
    fs.unlinkSync(f);
    /* 顺手把 .order.txt 里这条身份串摘掉，免得删掉的剧本在排序清单里越积越多 */
    try { const order = readOrder() || []; const i = order.indexOf(s); if (i >= 0) { order.splice(i, 1); writeOrder(order); } } catch (e) {}
    return markDeleted(s);   // 墓碑以身份串为 key，与 docs 对齐
  }
  return null;
}

function authed(req) {
  if (!ACCESS_KEY) return true;
  const u = new URL(req.url, 'http://localhost');
  return u.searchParams.get('key') === ACCESS_KEY || req.headers['x-access-key'] === ACCESS_KEY;
}
function send(res, code, body, type) {
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(u.pathname);
  const method = req.method;

  /* CORS 预检 */
  if (method === 'OPTIONS') { send(res, 204, ''); return; }

  /* ── 数据接口鉴权（页面本身公开，数据必须对口令） ── */
  if (p.startsWith('/api/') && !authed(req)) {
    send(res, 401, JSON.stringify({ error: 'auth required' }));
    return;
  }

  /* ── API：文档列表（seeded：是否已初始化过数据，用于前端区分首次使用/被删光） ── */
  if (p === '/api/docs' && method === 'GET') {
    const docs = listDocs();
    const seeded = docs.length > 0 || fs.existsSync(path.join(DATA_DIR, '.seeded'));
    send(res, 200, JSON.stringify({ docs, seeded }));
    return;
  }

  /* ── API：备份包（GET 导出全部 / POST 导入恢复） ── */
  if (p === '/api/backup' && method === 'GET') {
    const docs = {};
    for (const it of listDocs()) {
      const text = readDocRaw(it.name);
      if (text != null) {
        const { meta } = parseFront(text);
        docs[it.name] = { md: text, updated: meta.updated || null };
      }
    }
    send(res, 200, JSON.stringify({ exportedAt: new Date().toISOString(), docs, groups: readGroups() }));
    return;
  }
  if (p === '/api/backup' && method === 'POST') {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 8e6) { res.writeHead(413); res.end(); req.destroy(); }
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const docs = data && data.docs;
        if (!docs || typeof docs !== 'object') throw new Error('bad');
        if (data.groups) writeGroups(data.groups);   /* 先恢复分组：建好文件夹、确定归属，文档才好落位 */
        let n = 0;
        for (const name of Object.keys(docs)) {
          const d = docs[name];
          if (d && typeof d === 'object' && d.md != null) { writeDoc(name, d); n++; }
        }
        send(res, 200, JSON.stringify({ ok: true, imported: n }));
      } catch (e) {
        send(res, 400, JSON.stringify({ error: 'bad backup' }));
      }
    });
    return;
  }

  /* ── API：同步（浏览器本地副本 ⇄ 云端） ──
     一次给全量：每篇的正文 + 修改时间，外加「谁被删了、什么时候」的墓碑。
     前端拿它跟本地副本逐篇比时间，新的那份胜出——没有墓碑的话，
     「云端删掉了」和「云端从来没这出戏」是分不清的，两边需求相反。 */
  if (p === '/api/sync' && method === 'GET') {
    const docs = {}, deleted = readDeleted();
    for (const it of listDocs()) {
      const text = readDocRaw(it.name);
      if (text != null) {
        const { meta } = parseFront(text);
        docs[it.name] = { md: text, updated: meta.updated || null };
        delete deleted[it.name];   /* 文件还在：墓碑是脏数据，顺手抹掉 */
      }
    }
    send(res, 200, JSON.stringify({ syncedAt: new Date().toISOString(), docs, deleted }));
    return;
  }

  /* ── API：分组（组列表 + 剧本归属） ── */
  if (p === '/api/groups' && method === 'GET') {
    send(res, 200, JSON.stringify(readGroups()));
    return;
  }
  if (p === '/api/groups' && method === 'POST') {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 3e6) { res.writeHead(413); res.end(); req.destroy(); }
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const saved = writeGroups(data);
        if (!saved) throw new Error('bad');
        send(res, 200, JSON.stringify({ ok: true, groups: saved.groups, docs: saved.docs, updated: saved.updated }));
      } catch (e) {
        send(res, 400, JSON.stringify({ error: 'bad json' }));
      }
    });
    return;
  }

  /* ── API：持久化剧本排列顺序 ── */
  if (p === '/api/order' && method === 'POST') {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 3e6) { res.writeHead(413); res.end(); req.destroy(); }
    });
    req.on('end', () => {
      try {
        const { order } = JSON.parse(body);
        if (!Array.isArray(order)) throw new Error('bad');
        const names = new Set(listDocs().map(x => x.name));
        const cleaned = order.filter(n => typeof n === 'string' && names.has(n));
        listDocs().forEach(x => { if (!cleaned.includes(x.name)) cleaned.push(x.name); });
        writeOrder(cleaned);
        send(res, 200, JSON.stringify({ ok: true, order: cleaned }));
      } catch (e) {
        send(res, 400, JSON.stringify({ error: 'bad json' }));
      }
    });
    return;
  }

  /* ── API：清除本地删除墓碑（同步把本地删除推到云端后，把本地这份墓碑消掉，避免 .deleted.json 无限膨胀） ── */
  if (p === '/api/deleted' && method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 3e6) { res.writeHead(413); res.end(); req.destroy(); } });
    req.on('end', () => {
      try {
        const { names } = JSON.parse(body);
        if (Array.isArray(names)) for (const n of names) if (typeof n === 'string') clearDeleted(n);
        send(res, 200, JSON.stringify({ ok: true }));
      } catch (e) {
        send(res, 400, JSON.stringify({ error: 'bad json' }));
      }
    });
    return;
  }

  /* ── API：重命名剧本（改显示名，文件也跟着改名，但不挪文件夹） ──
     入参 { id, name }：把 显示名_id.md 的 frontmatter name 改为新显示名，
     并把文件改名为 新显示名_id.md；同时更新 .order.txt 里对应的身份串。 */
  if (p === '/api/doc/rename' && method === 'POST') {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 3e6) { res.writeHead(413); res.end(); req.destroy(); }
    });
    req.on('end', () => {
      try {
        const { id, name } = JSON.parse(body);
        if (!id || typeof id !== 'string' || !name || typeof name !== 'string') throw new Error('bad');
        const f = docFileById(id);
        if (!f) { send(res, 404, JSON.stringify({ error: 'not found', id })); return; }
        const { meta, body: bodyText } = parseFront(fs.readFileSync(f, 'utf8'));
        meta.name = name;
        const fm = ['---',
          'updated: ' + (meta.updated || new Date().toISOString()),
          'name: ' + JSON.stringify(name), '---', ''];
        fs.writeFileSync(f, fm.join('\n') + bodyText, 'utf8');
        /* 文件也跟着改名：显示名_id.md → 新显示名_id.md（id 不变，唯一性由后缀保证） */
        const newFile = path.join(path.dirname(f), docFileName(id, name));
        if (newFile !== f) { try { moveFileTo(f, newFile); } catch (e) {} }
        /* 顺序清单里的身份串同步换成新显示名§id */
        const order = readOrder() || [];
        const oi = order.findIndex(x => parseDocId(x) === id);
        const newIdentity = docIdentity(name, id);
        if (oi >= 0) order[oi] = newIdentity; else order.push(newIdentity);
        writeOrder(order);
        send(res, 200, JSON.stringify({ ok: true, id, name }));
      } catch (e) {
        send(res, 400, JSON.stringify({ error: 'bad json' }));
      }
    });
    return;
  }

  /* ── API：单个文档 GET / POST / DELETE ── */
  const m = p.match(/^\/api\/doc\/(.+)$/);
  if (m) {
    const name = m[1];
    if (method === 'GET') {
      const text = readDocRaw(name);
      if (text != null) send(res, 200, text, 'text/markdown; charset=utf-8');
      else send(res, 404, JSON.stringify({ error: 'not found', name }));
      return;
    }
    if (method === 'POST') {
      let body = '';
      req.on('data', c => {
        body += c;
        if (body.length > 3e6) { res.writeHead(413); res.end(); req.destroy(); }
      });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!data || typeof data !== 'object') throw new Error('bad');
          const saved = writeDoc(name, data);
          send(res, 200, JSON.stringify({ ok: true, updated: saved.updated }));
        } catch (e) {
          send(res, 400, JSON.stringify({ error: 'bad json' }));
        }
      });
      return;
    }
    if (method === 'DELETE') {
      const removedAt = delDoc(name);      /* 删除时刻写进墓碑，一并返回给同步 */
      if (removedAt) {
        /* 顺手清掉分组归属，免得留下指向已删剧本的脏映射 */
        try {
          const g = readGroups();
          if (g.docs[name] != null) { delete g.docs[name]; g.updated = new Date().toISOString(); writeGroups(g); }
        } catch (e) { /* 同上，不影响删除本身 */ }
        /* 删光后打标记，前端据此不再回填演示剧本（区分「首次使用」与「删光」） */
        if (listDocs().length === 0) {
          try { fs.writeFileSync(path.join(DATA_DIR, '.seeded'), 'seeded', 'utf8'); } catch (e) {}
        }
        send(res, 200, JSON.stringify({ ok: true, name, updated: removedAt }));
      } else {
        send(res, 404, JSON.stringify({ error: 'not found', name }));
      }
      return;
    }
    send(res, 405, JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  /* ── 静态文件（console/ 目录） ── */
  const rel = p === '/' ? '/index.html' : p;
  const file = path.normalize(path.join(CONSOLE, rel));
  if (!file.startsWith(CONSOLE)) { send(res, 403, 'forbidden', 'text/plain; charset=utf-8'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { send(res, 404, 'Not Found', 'text/plain; charset=utf-8'); return; }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    send(res, 200, data, type);
  });
});

/* ═════════════ 一次性迁移：旧数据（文件以剧本名命名、.groups.json 以名为 key）
   转为新模型（文件以 id 命名、显示名进 frontmatter、.groups.json 以身份串为 key）。
   只在 _idv 缺失时跑一次，幂等。 */
function genDocId() { return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function migrateToIdStorage() {
  try {
    let raw = null;
    try { raw = JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8')); } catch (e) {}
    if (raw && raw._idv) return;                         // 已迁移
    const keys = Object.keys((raw && raw.docs) || {});
    if (keys.some(k => k.indexOf(DOC_SEP) >= 0)) {       // 已是身份串 key，仅补标记
      try { raw._idv = 1; fs.writeFileSync(GROUPS_FILE, JSON.stringify(raw, null, 2)); } catch (e) {}
      return;
    }
    const files = [];
    walkMd(DATA_DIR, files);
    const oldNameToId = {}, oldNameToDisplay = {};
    for (const f of files) {
      const oldName = path.basename(f).slice(0, -3);
      const id = genDocId();
      let meta = {}, body = '';
      try { const pf = parseFront(fs.readFileSync(f, 'utf8')); meta = pf.meta; body = pf.body; } catch (e) {}
      const display = (meta.name != null) ? String(meta.name) : oldName;
      const fm = ['---',
        'updated: ' + (meta.updated || new Date().toISOString()),
        'name: ' + JSON.stringify(display), '---', ''].join('\n');
      const newPath = path.join(path.dirname(f), docFileName(id, display));
      try { fs.writeFileSync(newPath, fm + body, 'utf8'); fs.unlinkSync(f); } catch (e) {}
      oldNameToId[oldName] = id; oldNameToDisplay[oldName] = display;
    }
    const newDocs = {};
    const oldDocs = (raw && raw.docs) || {};
    for (const oldName of Object.keys(oldDocs)) {
      const id = oldNameToId[oldName];
      if (!id) continue;
      newDocs[docIdentity(oldNameToDisplay[oldName] || oldName, id)] = oldDocs[oldName];
    }
    const groups = (raw && Array.isArray(raw.groups))
      ? raw.groups.map(g => ({ id: g.id, name: g.name, open: g.open !== false, dir: g.dir })) : [];
    fs.writeFileSync(GROUPS_FILE, JSON.stringify({ _idv: 1, groups, docs: newDocs }, null, 2), 'utf8');
    try {
      const order = readOrder() || [];
      const newOrder = order.map(n => { const id = oldNameToId[n]; return id ? docIdentity(oldNameToDisplay[n] || n, id) : n; });
      writeOrder(newOrder);
    } catch (e) {}
  } catch (e) { /* 迁移失败不阻断启动 */ }
}

/* 一次性迁移文件名：旧 <id>.md → 显示名_id.md（带显示名、仍按 id 唯一）。
   仅处理旧 id 格式文件，幂等可重复跑——已是 显示名_id.md 的会被跳过。 */
function migrateFilenames() {
  try {
    const files = [];
    walkMd(DATA_DIR, files);
    for (const f of files) {
      const base = path.basename(f).slice(0, -3);
      if (base.indexOf('_') >= 0) continue;            // 已是 显示名_id 格式
      if (!/^d[0-9a-z]+$/i.test(base)) continue;      // 只处理旧 id 格式，避免误改其它 .md
      const id = base;
      let display = id;
      try { const { meta } = parseFront(fs.readFileSync(f, 'utf8')); if (meta.name != null) display = String(meta.name); } catch (e) {}
      const newFile = path.join(path.dirname(f), docFileName(id, display));
      if (newFile !== f) { try { moveFileTo(f, newFile); } catch (e) {} }
    }
  } catch (e) {}
}
/* 启动：先迁移旧数据，再把「组 → 文件夹」对齐一次（幂等），最后统一文件名格式。 */
try { migrateToIdStorage(); } catch (e) {}
try { writeGroups(readGroups()); } catch (e) {}
try { migrateFilenames(); } catch (e) {}

/* 绑定到 0.0.0.0（所有可用网卡），局域网内其他设备用 本机IP:端口 即可访问。
   端口默认 8910，可用环境变量 PORT 覆盖。 */
server.listen(PORT, '0.0.0.0', () => {
  const lan = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of (ifs[name] || [])) {
      /* 只要 IPv4、且不是回环地址（127.x） */
      if (ni.family === 'IPv4' && !ni.internal) lan.push(ni.address);
    }
  }
  console.log('[幕间] server running on port ' + PORT + '  (data dir: ' + DATA_DIR + ')');
  console.log('[幕间] 本机访问：  http://127.0.0.1:' + PORT);
  if (lan.length) {
    console.log('[幕间] 局域网访问：' + lan.map(ip => ' http://' + ip + ':' + PORT).join('  '));
  } else {
    console.log('[幕间] 未检测到可用局域网网卡，仅本机可访问');
  }
});
