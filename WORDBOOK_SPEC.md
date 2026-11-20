# 词库源格式与制作规范 (Wordbook Specification)

`vocab-sieve` 采用**软件与词库完全解耦**的设计。你可以随时增删、替换或自制词库，无需改动界面或后端代码。

---

## 一、词库如何启用与切换

仓库中有两个与词库相关的目录：

- `wordbooks/`：成品词库仓库（预置 `mwvb.json`、`wpme.json`、`cet6.json`），**不会**直接出现在软件里。
- `lexicon/`：运行时激活目录。软件启动时会自动加载这里的所有 `.json` 词库（除 `manifest.json` 和 `user_progress.json` 之外）。

操作方式：

1. **启用某本词库**：把 `wordbooks/` 里的 `.json` 文件（或你自己生成的 `.json`）**复制**到 `lexicon/` 目录下，刷新界面即可在左上角词库栏看到。
2. **停用某本词库**：把不需要的 `.json` 从 `lexicon/` 移走或删除即可（例如启用自己的词库后，可以删掉演示用的 `lexicon/sample.json`）。
3. **进度隔离**：你的刷词记录保存在 `lexicon/user_progress.json`，每日备份在 `lexicon/backup/`，按每条词的 `id` 存储，增删词库不会丢失其他词库的进度。

> 如果想让词库放在电脑上的其他文件夹（例如同步盘），可以设置环境变量 `VOCAB_LEXICON_DIR=/你的词库路径`，或者把路径写入 `~/.gemini/config/vocab_lexicon_path.txt`。

---

## 二、词库 JSON 标准格式

一个词库是一个 UTF-8 编码的 `.json` 文件（建议文件名只用英文、数字、下划线或连字符，例如 `toefl.json`）。

### 1. 顶层结构

```json
{
  "id": "toefl",
  "title": "TOEFL 核心词汇",
  "shortTitle": "托福核心",
  "description": "10 个单元 · 800 个词汇",
  "totalWords": 800,
  "units": [
    { "id": "Unit 1", "title": "Unit 1", "wordCount": 80 }
  ],
  "words": [
    { "...单词对象..." }
  ]
}
```

| 顶层字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 词库唯一标识（建议与文件名一致，仅限英文/数字/`_`/`-`） |
| `title` | 是 | 词库完整名称 |
| `shortTitle` | 否 | 顶部切换栏显示的短名称，不填则用 `title` |
| `description` | 否 | 词库简要描述 |
| `totalWords` | 否 | 词条总数 |
| `units` | 是 | 单元列表，每项为 `{ "id": "单元ID", "title": "单元显示名", "wordCount": 数量 }`。单词的 `unit` 字段必须和这里的 `id` 对应 |
| `words` | 是 | 单词对象数组 |

### 2. 单个单词对象字段

#### 必填字段（满足这几个字段，软件五个阶段即可全部正常运行）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 全局唯一 ID，推荐格式：`<book>:<unit>:<word>`（例如 `toefl:Unit 1:ubiquitous`） |
| `word` | string | 单词拼写（可带简短标注） |
| `cleanWord` | string | 纯净小写词头（用于发音、例句高亮和二筛遮罩，例如 `ubiquitous`） |
| `book` | string | 所属词库 `id` |
| `unit` | string | 所属单元 `id`（需与顶层 `units[].id` 一致） |
| `order` | number | 单元内序号（从 `1` 开始递增） |
| `zhMeaning` | string | 中文释义（只有英文释义时可留空，建议带词性前缀如 `[adj.]` 或 `adj.`） |

#### 可选精学字段（在「② 精学」与「弹窗详情」中展示，没有可留空 `""` 或 `[]`）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `pos` | string | 词性，如 `noun`、`adjective`、`verb` |
| `phonetics` | object | 音标对象：`{ "uk": "英音", "us": "美音", "respell": "谐音/拼读提示" }` |
| `enMeaning` | string | 英文释义 |
| `rootGroup` | string | 词根分组标题（例如 `BENE`，同组词会在精学页聚合展示 `rootIntro`） |
| `rootIntro` | string | 词根组导语（同 `unit` 下同一个 `rootGroup` 会显示横幅介绍） |
| `rootBreakdown` | string | 词根词缀拆解，推荐格式：`前缀（义） + 词根（义） + 后缀 → 词义` |
| `etymology` | string | 简明词源说明（一两句话即可） |
| `contextExplanation` | string | 语境辨析 / 考点 / 助记 |
| `examples` | array | 例句数组：`[{ "en": "英文例句", "zh": "中文翻译", "source": "来源" }]` |
| `cognates` | array | 同根词/关联词拼写数组，例如 `["benefactor", "beneficiary"]`（点击可直接跳转） |

### 3. 最小可用样板 vs 完整精学样板

**最小可用单词条目（适合快速导入个人生词本）：**

```json
{
  "id": "my_notes:Unit 1:ubiquitous",
  "word": "ubiquitous",
  "cleanWord": "ubiquitous",
  "book": "my_notes",
  "unit": "Unit 1",
  "order": 1,
  "zhMeaning": "adj. 无处不在的，普遍存在的"
}
```

**完整精学单词条目（参考 `lexicon/sample.json`）：**

可完整查看 [`lexicon/sample.json`](lexicon/sample.json)，界面保持干净简洁，缺失可选字段会自动隐藏对应区块。

---

## 三、如何制作自己的词库

### 方法 1：用 Excel / CSV 模板一键转换（零依赖 Python 脚本）

1. 用 Excel 或文本编辑器打开 [`tools/template_words.csv`](tools/template_words.csv)，按表头填写你的单词。
   - **只有 `word` 和 `zhMeaning`（或 `enMeaning`）是必须填的**，其余列均可留空。
   - 同一词条需要多条例句时，在 `example_en` 和 `example_zh` 中用 ` || ` 分隔。
   - `cognates` 用英文逗号 `,` 分隔。
2. 另存为 UTF-8 CSV（或直接修改模板保存），运行仓库自带转换脚本：

```bash
python3 tools/csv_to_wordbook.py tools/template_words.csv \
  -o lexicon/my_vocab.json \
  --id my_vocab \
  --title "我的专属词库" \
  --short-title "我的词库"
```

3. 生成的 `lexicon/my_vocab.json` 会自动被软件识别，刷新页面即可使用。

### 方法 2：把资料直接丢给 AI，让 AI 生成词库

如果你手头只有 PDF、Word、TXT、网页笔记或凌乱的 Excel，可以把下面的提示词连同你的单词文件发给任意 AI 助手：

```text
请帮我把附件里的单词整理成一份可直接放入 vocab-sieve 的 lexicon/ 目录使用的 JSON 词库文件。
要求：
1. 严格阅读仓库里的 WORDBOOK_SPEC.md 和 lexicon/sample.json，完全遵循其中的 JSON 字段结构（包含 id、title、shortTitle、description、totalWords、units、words）。
2. 每个单词必须包含 id（格式 <book_id>:<unit>:<word>）、word、cleanWord、book、unit、order、zhMeaning；如果有能力补充音标(phonetics)、词性(pos)、词根拆解(rootBreakdown)、简明词源(etymology)和一条实用例句(examples)，也请一并补全，保持中文简明准确、不写废话。
3. 生成完成后保存为 lexicon/<book_id>.json，并用 python3 验证 JSON 合法性与 units 计数一致。
```
