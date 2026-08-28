#!/usr/bin/env node
/**
 * 剧集文件批量重命名工具 —— 本地服务端
 *
 * 零外部依赖，需要 Node.js 18+。
 * 启动：node server.mjs [端口] [--no-open]
 * 默认端口 3710，仅监听 127.0.0.1（本机访问）。
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOG_DIR = path.join(__dirname, 'logs');
const MAX_BODY = 2 * 1024 * 1024;
const MAX_BATCH = 500;

/* ---------------- 文件类型定义 ---------------- */
const VIDEO_EXTS = new Set([
  '.mp4', '.mkv', '.avi', '.mov', '.flv', '.wmv', '.ts', '.m2ts', '.mts',
  '.webm', '.rmvb', '.rm', '.mpg', '.mpeg', '.m4v', '.3gp', '.ogm','.strm'
]);
const SUB_EXTS = new Set([
  '.srt', '.ass', '.ssa', '.sub', '.smi', '.vtt', '.idx', '.sup', '.lrc',
]);

/* 常见字幕语言标记（重命名时保留，如 S01E01.chs.srt） */
const LANG_TAGS = new Set([
  'chs', 'cht', 'chi', 'zho', 'zh', 'zh-cn', 'zh-tw', 'zh-hk', 'zh-hans',
  'zh-hant', 'cmn', 'yue', 'cn', 'hk', 'tw', 'hans', 'hant', 'trad', 'sim',
  'en', 'eng', 'ja', 'jp', 'jpn', 'ko', 'kor', 'kr', 'fr', 'fra', 'fre',
  'de', 'deu', 'ger', 'es', 'spa', 'ru', 'rus', 'pt', 'por', 'it', 'ita',
  'ar', 'ara', 'th', 'tha', 'vi', 'vie', 'tr', 'tur', 'nl', 'pl', 'sv',
  'da', 'fi', 'no', 'he', 'id', 'ms', 'hi', 'ta', 'fa', 'uk', 'cs', 'hu',
  'ro', 'el', 'bg', 'sr', 'hr', 'sk', 'sl', 'lt', 'lv', 'et', 'big5', 'gb', 'sc', 'tc',
]);

const IGNORED_NAMES = new Set(['thumbs.db', 'desktop.ini', '.ds_store']);

const ext = (p) => path.extname(p).toLowerCase();
const baseNoExt = (p) => path.basename(p, path.extname(p));
const naturalCompare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const pad2 = (n) => String(n).padStart(2, '0');

/* ---------------- 集数 / 季数识别 ---------------- */
function extractEpisode(fileNameNoExt) {
  const s = String(fileNameNoExt || '').trim();
  if (!s) return null;
  const patterns = [
    /s\s*\d{1,2}\s*e\s*p?\s*(\d{1,3})/i, // S01E01 / S1EP01 / s01e01
    /\bepisode\s*(\d{1,3})\b/i,           // Episode 01
    /\bep\s*(\d{1,3})\b/i,                // EP01
    /\be\s*(\d{1,3})\b/i,                 // E01
    /第\s*(\d{1,3})\s*[集话話]/u,         // 第01集 / 第05话
    /\[(\d{1,3})\]/,                      // [01]
    /\((\d{1,3})\)/,                      // (01)
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= 0 && n <= 999) return n;
    }
  }
  // 兜底：独立的 1~2 位数字（避免把 1080p / 720p / 年份当成集数）
  const m = s.match(/(?:^|[^\d])(\d{1,2})(?:[^\d]|$)/);
  if (m) return parseInt(m[1], 10);
  return null;
}

function extractSeason(dirName) {
  const s = String(dirName || '').trim();
  if (!s) return null;
  const patterns = [
    /^s\s*(\d{1,2})(?:$|[\s._\-\[\]])/i,     // S01 / s2 / S1.xxx
    /^season\s*(\d{1,2})(?:$|[\s._\-\[\]])/i, // Season 1
    /^第\s*(\d{1,2})\s*季/u,                  // 第1季
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return parseInt(m[1], 10);
  }
  if (/^\d{1,2}$/.test(s)) return parseInt(s, 10); // 纯数字文件夹名（如 "01"）
  return null;
}

/* 检测字幕文件名末尾的语言标记（仅最后一个点分段） */
function detectLangTag(fileNameNoExt) {
  const parts = String(fileNameNoExt || '').split('.');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1].trim();
  const tokens = last.toLowerCase().split(/[&_\-]/).filter(Boolean);
  if (!tokens.length || !tokens.every((t) => LANG_TAGS.has(t))) return null;
  return last;
}

/* 检测 .5 格式的特殊集数（如 5.5 / E05.5 / S01E05.5 / 第12.5集），提示用户手动输入目标编号 */
function isHalfEpisode(fileNameNoExt) {
  return /(?:^|[^\d.])\d{1,3}\.5\b/.test(String(fileNameNoExt || ''));
}

/* 计算文件的“配对键”：去除扩展名与语言标记后的文件名（小写），用于从头编号时视频与字幕配对 */
function pairKey(name, langTag) {
  let s = baseNoExt(name).toLowerCase();
  if (langTag) {
    const suffix = '.' + String(langTag).toLowerCase();
    if (s.endsWith(suffix)) s = s.slice(0, -suffix.length);
  }
  return s;
}

function buildNewName(season, episode, extStr, langTag) {
  const lang = langTag ? '.' + langTag : '';
  return `S${pad2(season ?? 1)}E${pad2(episode ?? 1)}${lang}${extStr}`;
}

/* ---------------- 目录扫描与结构识别 ---------------- */
async function readDirEntries(dirPath) {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    let reason = err.code === 'ENOENT' ? '路径不存在'
      : (err.code === 'EACCES' || err.code === 'EPERM') ? '没有访问权限'
      : (err.code || err.message);
    throw new Error(`无法读取文件夹（${reason}）: ${dirPath}`);
  }
}

function classifyEntries(entries) {
  const mediaFiles = [];
  const seasonDirs = [];
  const otherDirs = [];
  const otherFiles = [];
  for (const e of entries) {
    if (IGNORED_NAMES.has(e.name.toLowerCase())) continue;
    if (e.isDirectory()) {
      if (extractSeason(e.name) !== null) seasonDirs.push(e);
      else otherDirs.push(e);
    } else if (e.isFile()) {
      const x = ext(e.name);
      if (VIDEO_EXTS.has(x) || SUB_EXTS.has(x)) mediaFiles.push(e);
      else otherFiles.push(e);
    }
  }
  return { mediaFiles, seasonDirs, otherDirs, otherFiles };
}

/* 生成一个季（或一级剧集）文件夹内的文件条目，含集数提取、自动编号与冲突标记 */
function buildFileItems(dirents, seasonNum, folderPath) {
  const items = dirents.map((d) => {
    const name = d.name;
    const ex = ext(name);
    const noExt = baseNoExt(name);
    const isSub = SUB_EXTS.has(ex);
    return {
      name,
      folder: folderPath,
      season: seasonNum,
      ext: ex,
      kind: isSub ? 'sub' : 'video',
      episode: extractEpisode(noExt),
      autoNumber: null,
      langTag: isSub ? detectLangTag(noExt) : null,
      half: isHalfEpisode(noExt),
      renumber: null,
      newName: null,
      status: 'ok',
      conflictWith: null,
    };
  }).sort((a, b) => naturalCompare(a.name, b.name));

  // 无法识别集数的文件：按文件名排序，在已识别最大集数之后依次自动编号
  let max = 0;
  for (const it of items) if (it.episode !== null && it.episode > max) max = it.episode;
  let next = max + 1;
  for (const it of items) if (it.episode === null) { it.autoNumber = next; next += 1; }

  // “是否从头开始”模式使用的顺序编号：按原有排序（文件名自然排序）从头编号，
  // 视频与其同名字幕（配对键相同）共用同一编号，避免字幕错号
  const renumMap = new Map();
  let nextRenum = 1;
  for (const it of items) {
    const key = pairKey(it.name, it.langTag);
    if (!renumMap.has(key)) { renumMap.set(key, nextRenum); nextRenum += 1; }
    it.renumber = renumMap.get(key);
  }

  // 计算目标名（默认保留语言标记；执行时按界面选项重算）
  for (const it of items) {
    it.newName = buildNewName(it.season, it.episode ?? it.autoNumber, it.ext, it.langTag);
  }

  // 冲突标记（仅用于预览提示；执行时以磁盘实际情况为准）
  const currents = new Set(items.map((i) => i.name.toLowerCase()));
  for (const it of items) {
    if (it.name === it.newName) { it.status = 'noop'; continue; }
    if (it.name.toLowerCase() === it.newName.toLowerCase()) { it.status = 'caseonly'; continue; }
    const other = items.find((j) => j.name.toLowerCase() === it.newName.toLowerCase());
    if (other) {
      it.conflictWith = other.name;
      it.status = other.name !== other.newName ? 'chain' : 'exists';
    }
  }
  const seen = new Map();
  for (const it of items) {
    if (it.status !== 'ok') continue;
    const k = it.newName.toLowerCase();
    if (seen.has(k)) { it.status = 'duplicate'; it.conflictWith = seen.get(k); }
    else seen.set(k, it.name);
  }
  return items;
}

/* 构建一个剧集文件夹（一级 / 二级结构） */
async function buildShow(rootPath, showName, mediaFiles, seasonDirs, otherDirs, otherFiles) {
  const show = { name: showName, path: rootPath, level: 1, seasons: [], warnings: [] };
  if (otherFiles.length) {
    const names = otherFiles.slice(0, 3).map((f) => f.name).join('、');
    show.warnings.push(`已忽略 ${otherFiles.length} 个非媒体文件${otherFiles.length <= 3 ? `（${names}）` : ''}`);
  }
  if (otherDirs.length) {
    show.warnings.push(`已忽略未识别季数的子文件夹: ${otherDirs.map((d) => d.name).join('、')}`);
  }
  if (seasonDirs.length) {
    show.level = 2;
    for (const sd of [...seasonDirs].sort((a, b) => naturalCompare(a.name, b.name))) {
      const seasonNum = extractSeason(sd.name) ?? 1;
      const folderPath = path.join(rootPath, sd.name);
      const season = { season: seasonNum, folderName: sd.name, folderPath, files: [], warnings: [] };
      try {
        const ents = await readDirEntries(folderPath);
        const c = classifyEntries(ents);
        if (c.otherFiles.length) season.warnings.push(`已忽略 ${c.otherFiles.length} 个非媒体文件`);
        if (c.otherDirs.length) season.warnings.push(`已忽略子文件夹: ${c.otherDirs.map((d) => d.name).join('、')}`);
        if (!c.mediaFiles.length) season.warnings.push('该季文件夹内未发现视频或字幕文件');
        season.files = buildFileItems(c.mediaFiles, seasonNum, folderPath);
      } catch (err) {
        season.warnings.push(`无法读取该季文件夹: ${err.message}`);
      }
      show.seasons.push(season);
    }
    if (mediaFiles.length) {
      show.warnings.push(`检测到季文件夹（二级结构），剧集文件夹根目录下的 ${mediaFiles.length} 个媒体文件将被忽略`);
    }
  } else if (mediaFiles.length) {
    show.seasons.push({
      season: 1,
      folderName: null,
      folderPath: rootPath,
      files: buildFileItems(mediaFiles, 1, rootPath),
      warnings: [],
    });
  } else {
    show.level = 0;
    show.warnings.push('未发现视频/字幕文件或季文件夹，无法识别该文件夹结构');
  }
  return show;
}

async function buildShowFromDir(rootPath, dName) {
  const p = path.join(rootPath, dName);
  const entries = await readDirEntries(p);
  const c = classifyEntries(entries);
  return buildShow(p, dName, c.mediaFiles, c.seasonDirs, c.otherDirs, c.otherFiles);
}

/* 扫描根目录：识别其中的所有剧集文件夹 */
async function scanRoot(rootPath) {
  const entries = await readDirEntries(rootPath); // 根目录读取失败直接抛错
  const c = classifyEntries(entries);
  const shows = [];
  const warnings = [];
  const rootIsShow = c.mediaFiles.length > 0 || c.seasonDirs.length > 0;
  if (rootIsShow) {
    // 所选路径本身就是一个剧集文件夹（一级或二级）
    shows.push(await buildShow(rootPath, path.basename(rootPath) || rootPath, c.mediaFiles, c.seasonDirs, [], c.otherFiles));
  } else if (c.otherFiles.length) {
    warnings.push(`已忽略根目录下的 ${c.otherFiles.length} 个非媒体文件`);
  }
  for (const d of c.otherDirs) {
    try {
      shows.push(await buildShowFromDir(rootPath, d.name));
    } catch (err) {
      warnings.push(`无法读取文件夹 "${d.name}": ${err.message}`);
    }
  }
  shows.sort((a, b) => naturalCompare(a.name, b.name));

  const stats = { shows: shows.length, seasons: 0, files: 0, unrecognized: 0, conflicts: 0, noop: 0, halfEpisodes: 0 };
  for (const show of shows) {
    for (const season of show.seasons) {
      stats.seasons += 1;
      stats.files += season.files.length;
      for (const f of season.files) {
        if (f.episode === null) stats.unrecognized += 1;
        if (['duplicate', 'chain', 'exists'].includes(f.status)) stats.conflicts += 1;
        if (f.status === 'noop') stats.noop += 1;
        if (f.half) stats.halfEpisodes += 1;
      }
    }
  }
  return { root: rootPath, rootName: path.basename(rootPath) || rootPath, shows, warnings, stats };
}

/* ---------------- 扫描计划存储（执行重命名时的安全校验） ---------------- */
const plans = new Map(); // rootPath(绝对路径) -> { filesByKey: Map }

function buildFilesByKey(plan) {
  const m = new Map();
  for (const show of plan.shows) {
    for (const season of show.seasons) {
      for (const f of season.files) m.set(f.folder + '\u0000' + f.name, f);
    }
  }
  return m;
}

/* ---------------- 重命名执行 ---------------- */
/* Windows 下按大小写不敏感查找同名文件，返回磁盘上的实际名称或 null */
async function findExisting(folderPath, targetName) {
  if (process.platform === 'win32') {
    const names = await fs.readdir(folderPath).catch(() => []);
    const t = targetName.toLowerCase();
    return names.find((n) => n.toLowerCase() === t) || null;
  }
  const st = await fs.stat(path.join(folderPath, targetName)).catch(() => null);
  return st ? targetName : null;
}

/* 校验目标名称（自动计算或自定义）：不允许路径分隔符、Windows 非法字符与系统保留名 */
function isValidTargetName(n) {
  if (typeof n !== 'string') return false;
  const s = n.trim();
  if (!s || s.length > 255) return false;
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(s)) return false;
  if (s === '.' || s === '..' || s.endsWith('.')) return false;
  const stem = s.includes('.') ? s.slice(0, s.lastIndexOf('.')) : s;
  return !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem);
}

/* 判断目标路径是否位于扫描根目录内（移动文件的安全边界） */
function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/* 重命名（或同盘移动）单个文件；dstFolder 为目标文件夹（不存在时自动创建） */
async function renameOne(folder, srcName, dstFolder, dstName, mode) {
  if (folder === dstFolder && srcName === dstName) {
    return { name: srcName, newName: dstName, status: 'skipped', reason: '已是目标名称' };
  }
  const moving = folder !== dstFolder;
  const src = path.join(folder, srcName);
  const dst = path.join(dstFolder, dstName);
  try {
    await fs.mkdir(dstFolder, { recursive: true });
  } catch (err) {
    return { name: srcName, newName: dstName, status: 'failed', reason: `无法创建目标文件夹: ${err.message}` };
  }
  const existing = await findExisting(dstFolder, dstName);
  if (existing !== null) {
    if (!moving && existing.toLowerCase() === srcName.toLowerCase()) {
      // 目标即源文件本身（仅大小写不同）：两步重命名
      const tmp = path.join(folder, `.rename-tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${path.extname(srcName)}`);
      await fs.rename(src, tmp);
      try {
        await fs.rename(tmp, dst);
      } catch (err) {
        await fs.rename(tmp, src).catch(() => {});
        throw err;
      }
      return { name: srcName, newName: dstName, status: 'renamed', note: '大小写调整' };
    }
    const st = await fs.stat(path.join(dstFolder, existing)).catch(() => null);
    if (st && st.isDirectory()) {
      return { name: srcName, newName: dstName, status: 'failed', reason: `目标名称已被文件夹占用（${existing}）` };
    }
    if (mode === 'skip') {
      return { name: srcName, newName: dstName, status: 'skipped', reason: `目标文件已存在（${existing}）` };
    }
    if (mode === 'overwrite') {
      await fs.rm(path.join(dstFolder, existing), { force: true });
      await fs.rename(src, dst);
      return { name: srcName, newName: dstName, status: 'renamed', note: `已覆盖 ${existing}${moving ? `（已移动至 ${path.basename(dstFolder)}）` : ''}` };
    }
    // autonum: S01E01.mp4 -> S01E01 (2).mp4
    const ex = path.extname(dstName);
    const stem = dstName.slice(0, dstName.length - ex.length);
    for (let n = 2; n <= 999; n += 1) {
      const cand = `${stem} (${n})${ex}`;
      if ((await findExisting(dstFolder, cand)) === null) {
        await fs.rename(src, path.join(dstFolder, cand));
        return { name: srcName, newName: cand, status: 'renamed', note: `自动编号避免冲突${moving ? `（已移动至 ${path.basename(dstFolder)}）` : ''}` };
      }
    }
    throw new Error('自动编号重试次数过多，请检查文件夹内容');
  }
  await fs.rename(src, dst);
  return { name: srcName, newName: dstName, status: 'renamed', note: moving ? `已移动至 ${path.basename(dstFolder)}` : undefined };
}

/* ---------------- 操作日志 ---------------- */
const logs = [];
function addLog(level, msg, detail) {
  const entry = { ts: new Date().toISOString(), level, msg, detail: detail ?? null };
  logs.push(entry);
  if (logs.length > 1000) logs.splice(0, logs.length - 1000);
  persistLog(entry).catch(() => {});
  return entry;
}
async function persistLog(entry) {
  await fs.mkdir(LOG_DIR, { recursive: true });
  await fs.appendFile(path.join(LOG_DIR, 'rename.log'), JSON.stringify(entry) + '\n', 'utf8');
}

/* ---------------- HTTP 工具 ---------------- */
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('请求体不是有效的 JSON')); }
    });
    req.on('error', reject);
  });
}

/* ---------------- 接口处理 ---------------- */
async function handleScan(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  const input = String((body && body.path) || '').trim().replace(/^["']|["']$/g, '');
  if (!input) return json(res, 400, { ok: false, error: '请输入文件夹路径' });
  const rootPath = path.resolve(input);
  if (rootPath === path.parse(rootPath).root) {
    return json(res, 400, { ok: false, error: '不允许选择磁盘根目录，请选择具体的文件夹' });
  }
  try {
    const plan = await scanRoot(rootPath);
    plans.set(rootPath, { filesByKey: buildFilesByKey(plan) });
    addLog('info', `扫描完成：${plan.stats.shows} 个剧集 / ${plan.stats.files} 个文件`, { path: rootPath });
    return json(res, 200, { ok: true, ...plan });
  } catch (e) {
    addLog('error', '扫描失败', { path: rootPath, error: e.message });
    return json(res, 400, { ok: false, error: e.message });
  }
}

async function handleRename(req, res) {
  let body;
  try { body = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
  const { root, entries, conflictMode, keepLang } = body || {};
  const rootPath = path.resolve(String(root || ''));
  const plan = plans.get(rootPath);
  if (!plan) return json(res, 400, { ok: false, error: '请先扫描该文件夹后再执行重命名' });
  if (!['skip', 'overwrite', 'autonum'].includes(conflictMode)) {
    return json(res, 400, { ok: false, error: '无效的冲突处理模式' });
  }
  let list = entries;
  if (!Array.isArray(list)) list = [list];
  if (!list.length) return json(res, 400, { ok: false, error: '没有待重命名的文件' });
  if (list.length > MAX_BATCH) return json(res, 400, { ok: false, error: `单次最多重命名 ${MAX_BATCH} 个文件，请分批执行` });
  const keepLangOn = keepLang !== false;

  const results = [];
  for (const it of list) {
    const folder = path.resolve(String((it && it.folder) || ''));
    const name = String((it && it.name) || '');
    const key = folder + '\u0000' + name;
    const f = plan.filesByKey.get(key);
    if (!f) {
      results.push({ name, newName: name, status: 'failed', reason: '文件不在扫描结果中，已拒绝（请重新扫描）' });
      continue;
    }
    const ep = f.episode !== null ? f.episode : (f.autoNumber ?? 1);
    const computed = buildNewName(f.season, ep, f.ext, keepLangOn ? f.langTag : null);
    let newName = computed;
    // 允许自定义目标名称（预览中可编辑），执行前做安全校验；未提供或为空则使用自动计算值
    if (it && typeof it.newName === 'string' && it.newName.trim() !== '') {
      const custom = it.newName.trim();
      if (isValidTargetName(custom)) {
        newName = custom;
      } else {
        results.push({ name, newName: custom, status: 'failed', reason: '自定义目标名称无效（为空、含非法字符或为系统保留名）' });
        continue;
      }
    }
    // 允许移动到其他文件夹（分季存储）；目标文件夹必须在扫描根目录内
    const targetFolder = (it && typeof it.targetFolder === 'string' && it.targetFolder.trim() !== '')
      ? path.resolve(String(it.targetFolder))
      : folder;
    if (!isInside(rootPath, targetFolder)) {
      results.push({ name, newName, status: 'failed', reason: '目标文件夹不在扫描目录内，已拒绝' });
      continue;
    }
    try {
      results.push(await renameOne(folder, name, targetFolder, newName, conflictMode));
    } catch (e) {
      results.push({ name, newName, status: 'failed', reason: e.message || String(e) });
    }
  }
  const okN = results.filter((r) => r.status === 'renamed').length;
  const skipN = results.filter((r) => r.status === 'skipped').length;
  const failN = results.filter((r) => r.status === 'failed').length;
  addLog(failN ? 'warn' : 'info', `重命名批次完成：成功 ${okN}，跳过 ${skipN}，失败 ${failN}`, { path: rootPath, mode: conflictMode });
  return json(res, 200, { ok: true, results });
}

/* 运行外部命令：不捕获管道输出（兼容受限环境），结果由调用方通过临时文件读取 */
function runCommand(cmd, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
    } catch (e) {
      return reject(e);
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error('选择文件夹超时'));
    }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`选择器退出码 ${code}`));
    });
  });
}

async function handlePick(res) {
  if (process.platform !== 'win32') {
    return json(res, 400, { ok: false, error: '当前系统不支持图形化选择文件夹，请手动输入路径' });
  }
  // 结果写入临时文件回传（避免依赖管道捕获）
  const tmpFile = path.join(os.tmpdir(), `episode-renamer-pick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    // 置顶的隐形 owner 窗体：确保对话框出现在所有窗口最前，避免被浏览器窗口遮挡
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true',
    '$owner.ShowInTaskbar = $false',
    '$owner.Width = 0',
    '$owner.Height = 0',
    '$owner.Opacity = 0',
    '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen',
    '$owner.Show()',
    '$owner.Activate()',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$d.Description = '请选择剧集文件夹（其下应包含剧集文件夹或季文件夹）'",
    '$d.ShowNewFolderButton = $false',
    `if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Set-Content -LiteralPath '${tmpFile.replace(/'/g, "''")}' -Value $d.SelectedPath -Encoding UTF8 }`,
    '$owner.Close()',
  ].join('; ');
  let lastError = null;
  try {
    for (const cmd of ['powershell', 'pwsh']) {
      try {
        // -STA：WinForms 对话框要求单线程单元模式
        await runCommand(cmd, ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script], 120000);
        const selected = String(await fs.readFile(tmpFile, 'utf8').catch(() => '')).trim();
        if (selected) return json(res, 200, { ok: true, path: selected });
        return json(res, 200, { ok: false, error: '未选择文件夹' });
      } catch (e) {
        lastError = e;
      }
    }
  } finally {
    await fs.rm(tmpFile, { force: true }).catch(() => {});
  }
  const reason = lastError && lastError.message ? `：${lastError.message}` : '';
  return json(res, 500, { ok: false, error: `无法启动文件夹选择器（需要 PowerShell）${reason}，请手动输入路径` });
}

function handleExportLog(res) {
  const lines = logs.map((l) => `[${l.ts}] [${l.level.toUpperCase()}] ${l.msg}${l.detail ? ' :: ' + JSON.stringify(l.detail) : ''}`);
  const text = lines.join('\r\n') + (lines.length ? '\r\n' : '');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="rename-log-${stamp}.txt"`,
  });
  res.end(text);
}

let indexHtmlCache = null;
async function serveIndex(res) {
  try {
    if (!indexHtmlCache) indexHtmlCache = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(indexHtmlCache);
  } catch {
    json(res, 500, { ok: false, error: '缺少 public/index.html，请确认文件完整' });
  }
}

/* ---------------- 服务器 ---------------- */
function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return await serveIndex(res);
      if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (req.method === 'POST' && url.pathname === '/api/scan') return await handleScan(req, res);
      if (req.method === 'POST' && url.pathname === '/api/rename') return await handleRename(req, res);
      if (req.method === 'POST' && url.pathname === '/api/pick-folder') return await handlePick(res);
      if (req.method === 'GET' && url.pathname === '/api/log') return json(res, 200, { ok: true, logs: logs.slice(-200).reverse() });
      if (req.method === 'GET' && url.pathname === '/api/export-log') return handleExportLog(res);
      json(res, 404, { ok: false, error: '接口不存在' });
    } catch (e) {
      addLog('error', '服务器内部错误', { error: e.message });
      json(res, 500, { ok: false, error: e.message });
    }
  });
}

function startServer(port, host, noOpen) {
  const server = createServer();
  const urlText = `http://${host}:${port}`;
  server.listen(port, host, () => {
    console.log('==============================================');
    console.log('  剧集文件批量重命名工具已启动');
    console.log(`  请在浏览器打开: ${urlText}`);
    console.log('  按 Ctrl+C 停止服务');
    console.log('==============================================');
    if (!noOpen) setTimeout(() => openBrowser(urlText), 300);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`端口 ${port} 已被占用，请换一个端口启动，例如: node server.mjs ${port + 1}`);
    } else {
      console.error('服务启动失败:', err.message);
    }
    process.exit(1);
  });
  return server;
}

function openBrowser(url) {
  try {
    const plat = process.platform;
    const cmd = plat === 'win32' ? 'cmd' : plat === 'darwin' ? 'open' : 'xdg-open';
    const cmdArgs = plat === 'win32' ? ['/c', 'start', '', url] : [url];
    const child = spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* 忽略自动打开浏览器的失败 */ }
}

/* 直接运行时启动服务；被 import 时（如单元测试）不启动 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const PORT = parseInt(process.env.PORT, 10) || parseInt(args.find((a) => /^\d+$/.test(a)), 10) || 3710;
  const NO_OPEN = args.includes('--no-open') || process.env.NO_OPEN === '1';
  startServer(PORT, '127.0.0.1', NO_OPEN);
}

/* 供单元测试使用 */
export { extractEpisode, extractSeason, detectLangTag, buildNewName, isValidTargetName, isHalfEpisode, pairKey, isInside, scanRoot, startServer };
