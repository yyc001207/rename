// 集数/季数识别规则单元测试：node test/episode.test.mjs
import { extractEpisode, extractSeason, detectLangTag, buildNewName, isValidTargetName } from '../server.mjs';

let pass = 0;
let fail = 0;
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass += 1; console.log('PASS', label); }
  else { fail += 1; console.log('FAIL', label, '=> got', a, 'expected', e); }
}

// ---- 集数识别 ----
eq('EP01', extractEpisode('EP01'), 1);
eq('第01集', extractEpisode('第01集'), 1);
eq('纯数字 01', extractEpisode('01'), 1);
eq('[01]', extractEpisode('[01]'), 1);
eq('E01', extractEpisode('E01'), 1);
eq('Episode 12', extractEpisode('Episode 12'), 12);
eq('S01E05', extractEpisode('S01E05'), 5);
eq('s1e2', extractEpisode('s1e2'), 2);
eq('S01EP03', extractEpisode('S01EP03'), 3);
eq('S01.E04', extractEpisode('S01.E04'), 4);
eq('Friends.S03E12.1080p', extractEpisode('Friends.S03E12.1080p'), 12);
eq('第720话', extractEpisode('第720话'), 720);
eq('(04)', extractEpisode('(04)'), 4);
eq('无集数信息', extractEpisode('片头花絮'), null);
eq('年份不误判', extractEpisode('Movie.2019.1080p'), null);
eq('画质不误判', extractEpisode('1080p.x264'), null);
eq('720p 不误判', extractEpisode('Naruto.720p'), null);
eq('第1季不是集数', extractEpisode('老友记.第一季'), null);

// ---- 季数识别 ----
eq('S01', extractSeason('S01'), 1);
eq('s2', extractSeason('s2'), 2);
eq('Season 1', extractSeason('Season 1'), 1);
eq('Season 02', extractSeason('Season 02'), 2);
eq('第3季', extractSeason('第3季'), 3);
eq('Season 10.1080p', extractSeason('Season 10.1080p'), 10);
eq('纯数字 01', extractSeason('01'), 1);
eq('Specials 非季名', extractSeason('Specials'), null);
eq('S01E01 非季名', extractSeason('S01E01'), null);

// ---- 语言标记 ----
eq('chs', detectLangTag('S01E01.chs'), 'chs');
eq('chs&eng', detectLangTag('S01E01.chs&eng'), 'chs&eng');
eq('zh-cn', detectLangTag('S01E01.zh-cn'), 'zh-cn');
eq('无标记', detectLangTag('S01E01'), null);
eq('ass 扩展名非标记', detectLangTag('S01E01.ass'), null);
eq('1080p 非标记', detectLangTag('S01E01.1080p'), null);

// ---- 目标名构造 ----
eq('S01E01.mp4', buildNewName(1, 1, '.mp4', null), 'S01E01.mp4');
eq('S02E12.chs.srt', buildNewName(2, 12, '.srt', 'chs'), 'S02E12.chs.srt');
eq('S03E101.mkv', buildNewName(3, 101, '.mkv', null), 'S03E101.mkv');

// ---- 目标名称校验（自定义名称安全校验）----
eq('合法自定义名', isValidTargetName('S01E01.HEVC.mp4'), true);
eq('空名非法', isValidTargetName(''), false);
eq('纯空格非法', isValidTargetName('   '), false);
eq('正斜杠非法', isValidTargetName('a/b.mp4'), false);
eq('反斜杠非法', isValidTargetName('a\\b.mp4'), false);
eq('冒号非法', isValidTargetName('a:b.mp4'), false);
eq('问号非法', isValidTargetName('a?.mp4'), false);
eq('保留名非法', isValidTargetName('CON.mp4'), false);
eq('保留名带扩展非法', isValidTargetName('com1.txt'), false);
eq('普通 com10 合法', isValidTargetName('com10.txt'), true);
eq('尾部点非法', isValidTargetName('S01E01.mp4.'), false);
eq('点与点点非法', isValidTargetName('..'), false);
eq('超长名非法', isValidTargetName('x'.repeat(300)), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
