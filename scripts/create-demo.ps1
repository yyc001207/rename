# 创建演示用剧集文件结构（空文件），运行: pwsh -File scripts/create-demo.ps1
$ErrorActionPreference = 'Stop'
$base = Join-Path (Split-Path $PSScriptRoot -Parent) 'demo'
if (Test-Path $base) { Remove-Item $base -Recurse -Force }
New-Item -ItemType Directory -Path $base -Force | Out-Null

function New-File([string]$p) { New-Item -ItemType File -Path $p -Force | Out-Null }
function New-Dir([string]$p) { New-Item -ItemType Directory -Path $p -Force | Out-Null }

# ---- 一级结构：剧集文件夹内直接放媒体文件（判定为第一季）----
$s1 = Join-Path $base '老友记'
New-Dir $s1
New-File (Join-Path $s1 'EP01.mp4')
New-File (Join-Path $s1 'EP02.mp4')
New-File (Join-Path $s1 'EP03.mp4')
New-File (Join-Path $s1 '第04集.mkv')
New-File (Join-Path $s1 '[05].mkv')
New-File (Join-Path $s1 '06.mp4')
New-File (Join-Path $s1 'E05.5.mkv')   # 特殊集数(.5)：扫描时会醒目提示，需手动输入目标编号
New-File (Join-Path $s1 'Friends.S01E07.chs.srt')
New-File (Join-Path $s1 'Friends.S01E07.cht.srt')
New-File (Join-Path $s1 '片头花絮.mp4')   # 无集数信息，可开启“自动编号”

# ---- 二级结构：剧集文件夹内包含季文件夹 ----
$s2 = Join-Path $base '权力的游戏'
New-Dir $s2
$se1 = Join-Path $s2 'Season 1'
New-Dir $se1
New-File (Join-Path $se1 'S01E01.mp4')          # 已是目标名称
New-File (Join-Path $se1 'E02.mp4')
New-File (Join-Path $se1 'EP03.ass')
New-File (Join-Path $se1 '04.srt')
New-File (Join-Path $se1 'S01E05.chs&eng.srt')  # 双语字幕，保留语言标记
New-File (Join-Path $se1 'S01E05.mp4')
$se2 = Join-Path $s2 'Season 2'
New-Dir $se2
New-File (Join-Path $se2 '01.mp4')
New-File (Join-Path $se2 '第02集.mkv')
New-File (Join-Path $se2 'E03.mp4')
New-File (Join-Path $se2 '04.ass')
New-File (Join-Path $se2 '第05话.mp4')
$se3 = Join-Path $s2 'Season 3'
New-Dir $se3
New-File (Join-Path $se3 'S03E01.mp4')
New-File (Join-Path $se3 'ep2.mkv')
$behind = Join-Path $s2 'Behind the Scenes'     # 无法识别季数 → 忽略并警告
New-Dir $behind
New-File (Join-Path $behind 'making-of.mp4')

# ---- 二级结构 + 集数冲突演示 ----
$s3 = Join-Path $base '瑞克和莫蒂'
New-Dir $s3
$s3s1 = Join-Path $s3 'S1'
New-Dir $s3s1
New-File (Join-Path $s3s1 'E01.mp4')   # 与 EP01.mp4 都识别为第 1 集（同名冲突演示）
New-File (Join-Path $s3s1 'EP01.mp4')
New-File (Join-Path $s3s1 'EP02.mkv')

# 根目录下的非媒体文件（会被忽略并提示）
New-File (Join-Path $base '说明.txt')

Write-Host "演示文件夹已创建: $base"
