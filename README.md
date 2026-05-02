# 本地视频工具

这是一个面向本地视频整理的 Windows 工具集合。项目里有两个主要功能：

- `video_processor`：桌面端视频处理工具，核心程序是 `视频处理.py`。用于批量去片头片尾、生成缩略图、裁剪视频、按标签整理文件。
- `web_manager`：本地视频网页管理工具，核心程序是 `网页管理.py`。用于把本地视频目录网页化，方便在电脑或手机浏览、搜索、筛选、播放、改名和删除。

两个工具默认共用同一个视频目录：`library`。视频处理生成的缩略图会写回 `library`，网页管理会直接读取这些视频和缩略图。

## 两个程序分别做什么

### 1. 视频处理

`video_processor` 是一个本地桌面程序，适合在整理视频素材之前先做批处理。

它主要处理三类事情：

- 处理视频本身：批量去掉片头片尾，或者按指定宽高裁剪视频。
- 生成网页可用的缩略图：从视频中抽帧，合成同名 `.jpg` 缩略图。
- 整理本地文件：根据文件名前面的标签，把视频和同名图片移动到对应目录，并生成快照清单或整理报告。

它默认从 `配置.json` 里的 `资源库` 读取视频，处理结果也默认写回同一个资源库。这样生成缩略图后，不需要再复制文件，网页管理程序可以直接读取。

适合场景：

- 有一批 `.mp4` 视频，需要统一生成缩略图。
- 想批量去掉每个视频固定长度的片头或片尾。
- 想把视频按文件名前缀标签整理到目录里。
- 需要生成文件变化清单，知道哪些文件新增或删除。

### 2. 网页管理

`web_manager` 是一个本地 Flask 网页程序，适合把电脑上的视频目录变成一个手机也能访问的视频管理页面。

它主要做这些事：

- 扫描 `配置.json` 里的 `资源库`，列出里面的 `.mp4` 视频。
- 读取同名缩略图，让列表页不需要直接加载视频文件。
- 支持搜索、标签筛选、排序、随机浏览。
- 支持在线播放视频。
- 支持改名、改标签、删除到回收站。
- 支持用 FFprobe 重算视频时长，并缓存结果。

启动后，命令行窗口会显示本机访问地址和局域网访问地址。电脑和手机在同一个局域网时，可以用手机浏览器打开局域网地址来管理视频。

适合场景：

- 视频都在电脑上，但想用手机快速浏览。
- 想按标签筛选、搜索、随机查看视频。
- 想在网页里直接改名、改标签、删除不需要的视频。
- 想让本地视频目录变成一个轻量的视频库。

### 两者怎么配合

推荐流程是：

1. 把视频放进 `library`，或者在 `配置.json` 里把 `资源库` 指向你自己的视频目录。
2. 运行 `run_video_processor.bat`，用视频处理工具生成同名缩略图。
3. 运行 `run_web_manager.bat`，启动网页管理。
4. 在浏览器或手机上打开网页管理地址，浏览和整理同一个资源库。

简单说：`视频处理` 负责把资源库整理好，`网页管理` 负责把资源库浏览和管理起来。

## 设计说明

项目的目录名和启动脚本使用英文，是为了避免 Windows 批处理在中文路径下出现编码问题。工具界面、配置键和说明文档保留中文。

## 目录结构

```text
tool_video/
├── README.md
├── 配置.json
├── run_video_processor.bat
├── run_web_manager.bat
├── ../library/
│   ├── put_videos_and_matching_thumbnails_here
│   ├── sample_video.mp4
│   └── sample_video.jpg
├── ../recycle_bin/
│   └── deleted_files_go_here
├── ../reports/
│   └── generated_reports_go_here
├── video_processor/
│   ├── 视频处理.py
│   └── FFmpeg/
│       ├── ffmpeg.exe
│       ├── ffplay.exe
│       └── ffprobe.exe
└── web_manager/
    ├── 网页管理.py
    ├── requirements.txt
    ├── templates/
    │   └── index.html
    └── static/
        ├── app.js
        └── styles.css
```

三个无后缀空文件只是为了保留目录并说明用途：

- `../library/put_videos_and_matching_thumbnails_here`
- `../recycle_bin/deleted_files_go_here`
- `../reports/generated_reports_go_here`

## 下载后怎么用

1. 确认电脑已经安装 Python。
2. 把整个项目文件夹放到你想放的位置。
3. 按需要修改一级目录的 `配置.json`。
4. 双击 `run_video_processor.bat` 打开视频处理工具。
5. 双击 `run_web_manager.bat` 启动网页管理工具。

`run_web_manager.bat` 会检查 Flask 和 Pillow 是否可用。如果缺依赖，会自动执行：

```bat
python -m pip install -r requirements.txt
```

## 配置资源库

一级目录的 `配置.json` 是两个工具共用的配置文件：

```json
{
  "资源库": "../library",
  "回收站": "../recycle_bin",
  "报告": "../reports"
}
```

字段说明：

- `资源库`：视频和缩略图所在目录。视频处理和网页管理都会读这里。
- `回收站`：网页管理里删除的视频会移动到这里。
- `报告`：视频处理生成的快照清单和整理报告会保存到这里。

路径可以写相对路径，也可以写绝对路径。相对路径以项目一级目录为基准。

例如，把资源库改成外部目录：

```json
{
  "资源库": "D:/我的视频资源库",
  "回收站": "../recycle_bin",
  "报告": "../reports"
}
```

这样项目本体可以放在任意位置，视频文件仍然放在你自己的资源目录里。

## 资源库文件规则

视频和缩略图建议同名放在同一个目录：

```text
../library/
├── 标签 视频名称.mp4
└── 标签 视频名称.jpg
```

网页管理会递归扫描 `资源库` 下的 `.mp4` 文件，并自动寻找同名缩略图：

- `.jpg`
- `.jpeg`
- `.png`
- `.webp`

标签规则：

- 文件名第一个空格前的内容会作为标签。
- 如果文件名前缀不可用，会回退到顶层文件夹名。

## 视频处理工具

启动方式：

```bat
run_video_processor.bat
```

默认设置：

- 输入目录：跟随 `配置.json` 的 `资源库`
- 输出目录：跟随 `配置.json` 的 `资源库`
- 缩略图目录：跟随 `配置.json` 的 `资源库`
- FFmpeg：`video_processor/FFmpeg/ffmpeg.exe`
- FFprobe：`video_processor/FFmpeg/ffprobe.exe`

主要功能：

- 批量去除片头片尾
- 批量生成缩略图
- 批量裁剪视频
- 按标签归档
- 生成快照清单

运行过程中可能生成：

- `video_processor/settings.json`：视频处理工具自己的界面设置。
- `video_processor/snapshots.json`：快照清单记录。
- `reports/` 下的报告文件。

## 网页管理工具

启动方式：

```bat
run_web_manager.bat
```

启动后命令行窗口会显示：

- 本机访问地址，例如 `http://127.0.0.1:5000`
- 局域网访问地址，例如 `http://192.168.x.x:5000`

手机和电脑在同一个局域网时，可以用局域网地址访问。

主要功能：

- 浏览本地视频
- 搜索文件名、标签和目录
- 标签筛选
- 按时间、名称、大小、片长、随机排序
- 播放视频
- 重命名视频
- 修改标签
- 删除到回收站
- 重算视频时长

运行过程中可能生成：

- `web_manager/cache/durations.json`：视频时长缓存。这个文件是运行缓存，不需要手动维护。

## 推荐工作流

1. 把视频放入 `library`，或者在 `配置.json` 里把 `资源库` 指向你自己的视频目录。
2. 运行 `run_video_processor.bat`。
3. 在视频处理工具中生成缩略图。
4. 运行 `run_web_manager.bat`。
5. 用浏览器打开命令行窗口里显示的访问地址。
6. 在网页里浏览、搜索、筛选、播放、改名或删除视频。

## 注意事项

- 项目自带 FFmpeg 三件套，视频处理和网页管理的时长读取都依赖它们。
- 删除操作不会直接永久删除文件，而是移动到 `回收站` 配置对应的目录。
- 如果你把 `资源库` 指向外部目录，视频处理生成的缩略图也会写到那个外部目录。
- 如果网页管理里片长显示不准确，可以点击“重算时长”。
- 如果端口 `5000` 被占用，需要先关闭占用该端口的程序。

## 故障排查

如果双击启动没有反应：

- 确认 Python 可以在命令行中运行。
- 进入项目目录后手动执行 `run_video_processor.bat` 或 `run_web_manager.bat`，查看窗口输出。

如果网页管理启动失败：

- 确认 `web_manager/requirements.txt` 存在。
- 确认网络可用，首次运行可能需要安装依赖。
- 可以手动执行：

```bat
cd web_manager
python -m pip install -r requirements.txt
python 网页管理.py
```

如果视频处理提示 FFmpeg 不可用：

- 确认下面三个文件存在：

```text
video_processor/FFmpeg/ffmpeg.exe
video_processor/FFmpeg/ffprobe.exe
video_processor/FFmpeg/ffplay.exe
```
