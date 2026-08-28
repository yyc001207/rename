// 端到端 HTTP 测试（自建夹具，可重复运行）：node test/http-test.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startServer } from '../server.mjs';

const ROOT = path.join(process.cwd(), 'test-tmp');
let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log('PASS', name); }
  else { fail += 1; console.log('FAIL', name, extra ?? ''); }
}
async function exists(p) { try { await fs.access(p); return true; } catch { return false; } }

// ---- 自建测试夹具 ----
await fs.rm(ROOT, { recursive: true, force: true });
const fixture = {
  '老友记': ['EP01.mp4', 'EP02.mp4', 'EP03.mp4', '第04集.mkv', '[05].mkv', '06.mp4', 'Friends.S01E07.chs.srt', 'Friends.S01E07.cht.srt', 'E05.5.mkv', '片头花絮.mp4'],
  '权力的游戏/Season 1': ['S01E01.mp4', 'E02.mp4', 'EP03.ass', '04.srt', 'S01E05.chs&eng.srt', 'S01E05.mp4'],
  '权力的游戏/Season 2': ['01.mp4', '第02集.mkv', 'E03.mp4', '04.ass', '第05话.mp4'],
  '权力的游戏/Season 3': ['S03E01.mp4', 'ep2.mkv'],
  '权力的游戏/Behind the Scenes': ['making-of.mp4'],
  '瑞克和莫蒂/S1': ['E01.mp4', 'EP01.mp4', 'EP02.mkv'],
  '冲突测试/S1': ['E05.mp4', 'S01E05.mp4', 's01e09.mp4'],
  '自定义/S1': ['A.mp4', 'B.mp4'],
};
for (const [dir, files] of Object.entries(fixture)) {
  await fs.mkdir(path.join(ROOT, dir), { recursive: true });
  for (const f of files) await fs.writeFile(path.join(ROOT, dir, f), '');
}
await fs.writeFile(path.join(ROOT, '说明.txt'), '');

// 进程内启动服务（端口 0 = 随机空闲端口）
const server = startServer(0, '127.0.0.1', true);
const port = await new Promise((resolve, reject) => {
  server.once('listening', () => resolve(server.address().port));
  server.once('error', reject);
});
const base = `http://127.0.0.1:${port}`;
console.log('服务端口:', port);

async function post(p, obj) {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}
const scan = async (p) => (await post('/api/scan', { path: p })).data;

// 1. 首页
{
  const res = await fetch(base + '/');
  const html = await res.text();
  check('GET / 返回 200 且包含标题', res.status === 200 && html.includes('剧集'));
}

// 2. 扫描
let s = await scan(ROOT);
check('扫描成功', s && s.ok === true);
check('识别 5 个剧集文件夹', s.shows.length === 5, JSON.stringify(s.shows.map((x) => x.name)));
const showNames = s.shows.map((x) => x.name);
check('包含五个剧集名', ['老友记', '权力的游戏', '瑞克和莫蒂', '冲突测试', '自定义'].every((n) => showNames.includes(n)));

// 3. 一级结构：老友记
const lyj = s.shows.find((x) => x.name === '老友记');
check('老友记为一级结构', lyj.level === 1);
check('老友记按第一季处理', lyj.seasons[0].season === 1);
const lyjFiles = lyj.seasons[0].files;
check('老友记 10 个媒体文件', lyjFiles.length === 10);
check('EP01.mp4 → S01E01.mp4', lyjFiles.find((f) => f.name === 'EP01.mp4').newName === 'S01E01.mp4');
check('字幕保留语言标记 chs', lyjFiles.find((f) => f.name === 'Friends.S01E07.chs.srt').newName === 'S01E07.chs.srt');
const huaxu = lyjFiles.find((f) => f.name === '片头花絮.mp4');
check('无集数文件自动编号为 8', huaxu.episode === null && huaxu.autoNumber === 8);
const half = lyjFiles.find((f) => f.name === 'E05.5.mkv');
check('检测 .5 特殊集数（episode=5, half=true）', half && half.half === true && half.episode === 5);
check('统计特殊集数', s.stats.halfEpisodes === 1);
const chs2 = lyjFiles.find((f) => f.name === 'Friends.S01E07.chs.srt');
const cht2 = lyjFiles.find((f) => f.name === 'Friends.S01E07.cht.srt');
check('从头编号：视频/字幕配对同号', chs2.renumber === cht2.renumber);
check('从头编号：10 个文件 9 个编号连续', Math.max(...lyjFiles.map((f) => f.renumber)) === 9 && Math.min(...lyjFiles.map((f) => f.renumber)) === 1);

// 4. 二级结构：权力的游戏
const got = s.shows.find((x) => x.name === '权力的游戏');
check('权力的游戏为二级结构', got.level === 2);
check('季数识别 1/2/3', got.seasons.map((x) => x.season).join(',') === '1,2,3');
check('Behind the Scenes 被忽略并警告', got.warnings.some((w) => w.includes('Behind')));
const gotS1 = got.seasons.find((x) => x.folderName === 'Season 1');
check('S01E01.mp4 已是目标名称', gotS1.files.find((f) => f.name === 'S01E01.mp4').status === 'noop');
const dual = gotS1.files.find((f) => f.name === 'S01E05.chs&eng.srt');
check('双语字幕标记 chs&eng 保留', dual.langTag === 'chs&eng' && dual.newName === 'S01E05.chs&eng.srt');

// 5. 重复目标检测：瑞克和莫蒂
const rick = s.shows.find((x) => x.name === '瑞克和莫蒂');
const rs1 = rick.seasons.find((x) => x.folderName === 'S1');
check('检测到重复目标名称', rs1.files.filter((f) => f.status === 'duplicate').length === 1);

// 6. 重命名批次1：老友记（skip；.5 特殊集数按界面行为默认排除）
const sel1 = lyjFiles.filter((f) => f.episode !== null && !f.half);
check('老友记应重命名 8 个', sel1.length === 8);
let r = await post('/api/rename', { root: ROOT, entries: sel1.map((f) => ({ folder: f.folder, name: f.name })), conflictMode: 'skip', keepLang: true });
check('批次1 成功 8 个', r.data.results.filter((x) => x.status === 'renamed').length === 8, JSON.stringify(r.data.results));
check('S01E01.mp4 已生成', await exists(path.join(ROOT, '老友记', 'S01E01.mp4')));
check('原文件名 EP01.mp4 已不存在', !(await exists(path.join(ROOT, '老友记', 'EP01.mp4'))));

// 7. 重新扫描 → noop
s = await scan(ROOT);
const lyj2 = s.shows.find((x) => x.name === '老友记');
check('重扫后 S01E01.mp4 为 noop', lyj2.seasons[0].files.find((f) => f.name === 'S01E01.mp4').status === 'noop');

// 8. 批次2：权力的游戏 Season 1（S01E01.mp4 / S01E05.mp4 / S01E05.chs&eng.srt 已是目标名称，其余 3 个待重命名）
const gotS1b = s.shows.find((x) => x.name === '权力的游戏').seasons.find((x) => x.folderName === 'Season 1');
const sel2 = gotS1b.files.filter((f) => f.status !== 'noop');
check('GoT Season1 待重命名 3 个', sel2.length === 3, JSON.stringify(gotS1b.files.map((f) => [f.name, f.status])));
r = await post('/api/rename', { root: ROOT, entries: sel2.map((f) => ({ folder: f.folder, name: f.name })), conflictMode: 'skip', keepLang: true });
check('批次2 成功 3 个', r.data.results.filter((x) => x.status === 'renamed').length === 3, JSON.stringify(r.data.results));
check('双语字幕已保留', await exists(path.join(ROOT, '权力的游戏', 'Season 1', 'S01E05.chs&eng.srt')));

// 9. 冲突 skip：瑞克和莫蒂 S1 全部 3 个
s = await scan(ROOT);
const rs1b = s.shows.find((x) => x.name === '瑞克和莫蒂').seasons.find((x) => x.folderName === 'S1');
r = await post('/api/rename', { root: ROOT, entries: rs1b.files.map((f) => ({ folder: f.folder, name: f.name })), conflictMode: 'skip', keepLang: true });
const r9ok = r.data.results.filter((x) => x.status === 'renamed').length;
const r9skip = r.data.results.filter((x) => x.status === 'skipped');
check('冲突 skip：2 成功 1 跳过', r9ok === 2 && r9skip.length === 1 && /已存在/.test(r9skip[0].reason));

// 10. autonum：EP01.mp4 → S01E01 (2).mp4
s = await scan(ROOT);
const rs1c = s.shows.find((x) => x.name === '瑞克和莫蒂').seasons.find((x) => x.folderName === 'S1');
const ep01 = rs1c.files.find((f) => f.name === 'EP01.mp4');
check('EP01.mp4 标记目标已存在', ep01.status === 'exists');
r = await post('/api/rename', { root: ROOT, entries: [{ folder: ep01.folder, name: ep01.name }], conflictMode: 'autonum', keepLang: true });
check('autonum 生成 S01E01 (2).mp4', r.data.results[0].newName === 'S01E01 (2).mp4', JSON.stringify(r.data.results));
check('磁盘上存在 S01E01 (2).mp4', await exists(path.join(ROOT, '瑞克和莫蒂', 'S1', 'S01E01 (2).mp4')));

// 11. overwrite：冲突测试
s = await scan(ROOT);
const ct = s.shows.find((x) => x.name === '冲突测试').seasons.find((x) => x.folderName === 'S1');
const e05 = ct.files.find((f) => f.name === 'E05.mp4');
r = await post('/api/rename', { root: ROOT, entries: [{ folder: e05.folder, name: e05.name }], conflictMode: 'overwrite', keepLang: true });
check('overwrite 成功并记录覆盖', r.data.results[0].status === 'renamed' && /已覆盖/.test(r.data.results[0].note || ''));
check('E05.mp4 已被覆盖为 S01E05.mp4',
  (await exists(path.join(ROOT, '冲突测试', 'S1', 'S01E05.mp4'))) && !(await exists(path.join(ROOT, '冲突测试', 'S1', 'E05.mp4'))));

// 12. 仅大小写调整
const sc = ct.files.find((f) => f.name === 's01e09.mp4');
check('s01e09.mp4 标记大小写调整', sc.status === 'caseonly');
r = await post('/api/rename', { root: ROOT, entries: [{ folder: sc.folder, name: sc.name }], conflictMode: 'skip', keepLang: true });
check('大小写重命名成功且磁盘生效',
  r.data.results[0].status === 'renamed' && (await exists(path.join(ROOT, '冲突测试', 'S1', 'S01E09.mp4'))));

// 13. 自定义目标名称（预览中编辑，服务端校验 + 重复检查）
s = await scan(ROOT);
const zz = s.shows.find((x) => x.name === '自定义').seasons.find((x) => x.folderName === 'S1');
const zA = zz.files.find((f) => f.name === 'A.mp4');
const zB = zz.files.find((f) => f.name === 'B.mp4');
r = await post('/api/rename', { root: ROOT, entries: [{ folder: zA.folder, name: zA.name, newName: 'S01E10.HEVC.mp4' }], conflictMode: 'skip', keepLang: true });
check('自定义目标名称生效', r.data.results[0].status === 'renamed' && (await exists(path.join(ROOT, '自定义', 'S1', 'S01E10.HEVC.mp4'))));
r = await post('/api/rename', { root: ROOT, entries: [{ folder: zB.folder, name: zB.name, newName: 'S01E10.HEVC.mp4' }], conflictMode: 'skip', keepLang: true });
check('自定义名称与现有文件重复 → 跳过', r.data.results[0].status === 'skipped' && /已存在/.test(r.data.results[0].reason));
r = await post('/api/rename', { root: ROOT, entries: [{ folder: zB.folder, name: zB.name, newName: 'bad/name.mp4' }], conflictMode: 'skip', keepLang: true });
check('非法自定义名称 → 失败并给出原因', r.data.results[0].status === 'failed' && /无效/.test(r.data.results[0].reason));
r = await post('/api/rename', { root: ROOT, entries: [{ folder: zB.folder, name: zB.name, newName: 'bad\\name.mp4' }], conflictMode: 'skip', keepLang: true });
check('含反斜杠自定义名称 → 失败', r.data.results[0].status === 'failed');
r = await post('/api/rename', { root: ROOT, entries: [{ folder: zB.folder, name: zB.name }], conflictMode: 'skip', keepLang: true });
check('未提供自定义名称时回退到计算名 S01E02.mp4', r.data.results[0].status === 'renamed' && r.data.results[0].newName === 'S01E02.mp4');

// 14. 错误处理
r = await post('/api/scan', { path: path.join(ROOT, '不存在的文件夹xyz') });
check('无效路径返回 400 且给出原因', r.status === 400 && r.data.ok === false && r.data.error.length > 0);
r = await post('/api/rename', { root: 'C:\\', entries: [], conflictMode: 'skip' });
check('未扫描先重命名返回 400', r.status === 400 && /先扫描/.test(r.data.error));
r = await post('/api/scan', { path: '' });
check('空路径返回 400', r.status === 400);

// 15. 日志与导出
{
  const res = await fetch(base + '/api/log');
  const d = await res.json();
  check('日志接口返回记录', d.ok === true && d.logs.length > 0);
  const exp = await fetch(base + '/api/export-log');
  const text = await exp.text();
  check('导出日志包含重命名记录', exp.status === 200 && /重命名批次完成/.test(text));
}

// 16. 文件夹选择器：会弹出真实对话框，仅当设置 RUN_PICK_TEST=1 时交互测试
if (process.env.RUN_PICK_TEST === '1') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(base + '/api/pick-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: ctrl.signal });
    const d = await res.json().catch(() => null);
    check('pick-folder 返回 JSON 且不崩溃', d !== null && typeof d.ok === 'boolean');
    console.log('  pick-folder 返回:', JSON.stringify(d));
  } catch (e) {
    console.log('  SKIP pick-folder（20 秒超时，可能已弹出选择器或被环境阻断）:', e.name);
  } finally {
    clearTimeout(timer);
  }
} else {
  console.log('SKIP pick-folder（设置 RUN_PICK_TEST=1 可交互测试，会弹出真实对话框）');
}

console.log(`\n${pass} passed, ${fail} failed`);
server.close();
await fs.rm(ROOT, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
