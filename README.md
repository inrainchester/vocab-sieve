# 单词筛记 · Vocab Sieve

词库与界面解耦的**五阶段单词筛记工具**，界面干净克制，支持按词根/单元推进记忆，同时提供 **Antigravity 插件**、**本地网页独立版**以及由 AI 辅助适配打包为 **Windows / macOS 桌面应用**或**浏览器侧边栏扩展**的使用方式。

---

## 核心功能：五阶段筛词流程

1. **① 初筛词墙**：高密度词汇墙快速浏览，已认识的词点击或按 `Space` 直接筛掉，不认识的保留或标星（`S`）。
2. **② 词根精学**：按词根组/单元展示音标、中英释义、词根词缀拆解、简明词源、语境精讲、例句与同根词跳转，支持单卡专注模式与个人记忆笔记。
3. **③ 二次筛选**：支持**看英回中**与**看中回英**双向遮罩自测（快捷键 `M` 切换），支持悬浮/按 `V` 偷看释义与发音。
4. **④ 乱序复习**：针对已筛除、星标或高频易忘词做乱序抽查与打回重学。
5. **⑤ 极速听词**：自动连播词表发音，支持盲听、误判闪烁提示与错词回流，内置内存 LRU + 本地磁盘 MP3 缓存 + 系统语音兜底。

---

## 目录说明（软件与词库分离）

```text
vocab-sieve/
├── plugin.json                 # Antigravity 插件清单
├── start.mjs                   # 跨平台一键独立启动脚本（零第三方依赖）
├── WORDBOOK_SPEC.md            # 词库 JSON 格式规范与自制词库教程
├── sidecars/vocab_sieve/       # 前端界面 (index.html) 与服务端 (server.mjs)
├── lexicon/                    # 【运行目录】存放进度 user_progress.json、音频缓存及自制词库
│   ├── manifest.json
│   └── sample.json             # 3 词极简样板词库（可按需保留或删除）
├── wordbooks/                  # 【成品词库包】自动发现供左上角下拉选择，一次只挂载一本
│   ├── mwvb.json               # 小绿书 Merriam-Webster's Vocabulary Builder (1,196 词)
│   ├── wpme.json               # Word Power Made Easy (1,177 词)
│   └── cet6.json               # 六级词汇 CET-6 乱序版 (2,218 词)
└── tools/                      # 自制词库工具
    ├── csv_to_wordbook.py      # CSV/TSV 转词库 JSON 脚本（仅用 Python 标准库）
    └── template_words.csv      # 词表 CSV 样板
```

- 软件会自动扫描 `wordbooks/` 与 `lexicon/` 中的所有 `.json` 词库（轻量目录按文件修改时间缓存，无需手写或重复全量解析），打开时和切换词库时**一次只挂载当前选中的一本**，无需手动把 `wordbooks/` 里的内置词库复制到 `lexicon/`。
- 学习进度保存在 `lexicon/user_progress.json`（已被 `.gitignore` 忽略），不会混入代码仓库。

---

## 给同学：直接让你的 AI 帮你拉取并打包安装

如果你不想手动折腾配置，把下面这段指令和本仓库的 GitHub 地址发给你的 AI 编程助手（Antigravity、Cursor、Claude Code、Codex 等），AI 会根据你的电脑系统和需求自动装好：

```text
请帮我部署这个单词筛记工具（GitHub 地址：<填入你的仓库地址>）：
1. 帮我 git clone 仓库到本地，并检查本机是否安装了 Node.js (>=18)。
2. 词库说明：软件会自动扫描 wordbooks/ 和 lexicon/ 下的词库供左上角下拉选择，且采用“一次只挂载一本”的按需加载机制，无需手动复制内置词库；如果我只想保留特定几本词书，帮我从 wordbooks/ 或 lexicon/ 移除不需要的 .json 文件即可（比如可删掉演示用的 lexicon/sample.json）。
3. 部署形态由我选择（根据我当前的操作系统推荐一种最省事的方案，并替我完成打包和验证）：
   - 方案 A（Antigravity 插件）：把整个仓库目录安装/链接到 ~/.gemini/config/plugins/vocab-sieve（Windows 为 %USERPROFILE%\.gemini\config\plugins\vocab-sieve），启用即可在侧边栏打开。
   - 方案 B（零打包本地运行）：直接用 node start.mjs 启动（会拉起独立 HTTP 服务并自动以浏览器 App 独立窗口打开）。
   - 方案 C（Windows 桌面应用 / .exe）：帮我封装成双击即可打开、不弹黑色控制台窗口的桌面快捷方式（如调用 Edge/Chrome --app 模式），或用 Electron / pkg 打包成独立 .exe；同时确保词库目录 lexicon/ 留在可执行文件同级或用户文档目录下方便日后替换。
   - 方案 D（macOS 桌面应用 .app）：帮我用 osacompile 或 Electron 打包成 Vocab Sieve.app，支持双击启动（优先用 Chrome/Edge --app 窗口打开，并自动管理后台 node 进程）。
   - 方案 E（浏览器扩展插件）：帮我基于 sidecars/vocab_sieve/index.html 封装一个 Chrome/Edge Manifest V3 侧边栏（sidePanel）扩展，将进度存储适配为 chrome.storage.local（或继续连接本地服务），保留原有的词库选择与音频播放能力。
4. 如果我想添加自己的单词表，按 WORDBOOK_SPEC.md 和 tools/csv_to_wordbook.py 的格式帮我转换并放入 lexicon/。
```

---

## 手动快速启动（需 Node.js 18+）

```bash
# 1. 进入仓库目录
cd vocab-sieve

# 2. 启动（自动发现 wordbooks/ 与 lexicon/ 中的词库，拉起服务并打开独立浏览器窗口）
node start.mjs
```

其他常用命令：

- 仅启动服务（默认 `http://127.0.0.1:3899`）：`node start.mjs --no-open`
- 指定端口：`node start.mjs --port 4000`
- 自检服务与词库加载：`node start.mjs --check`
- 指定外部词库文件夹：`VOCAB_LEXICON_DIR=/path/to/my_lexicon node start.mjs`

---

## 自定义与制作新词库

详细字段规范、CSV 转换脚本用法与 AI 制词库提示词，请查看 [`WORDBOOK_SPEC.md`](WORDBOOK_SPEC.md)。
