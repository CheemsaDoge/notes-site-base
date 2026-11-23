# notes-site-base

可复用的交互式静态课程讲义站点底座（Static Study Notes Site Base）。将排版美学、中英开源阅读字体、构建时 KaTeX 渲染、双/单模式切换、概念首次提及速览卡、划词笔记本与可选 Cloudflare Workers + D1 跨设备同步打包为独立 npm 底座，任意新课程仓库只需维护 Markdown 讲义与 `site.config.json`。

## 核心特性

- **编辑出版级排版与暗黑模式**：温润浅色 / 暖黑深色自动与手动切换，零闪烁首屏注入；手机 `320px` 至桌面大屏严格单行顶栏与触控友好交互。
- **三档自托管中英阅读字体（零外部 CDN）**：
  - `宋体`（默认）：`Source Serif 4`（拉丁可变体 `200..900` 正体+斜体）+ `Noto Serif SC`（思源宋体 97 个 `unicode-range` 切片）；
  - `文楷`：`Source Serif 4` + `LXGW WenKai Screen`（霞鹜文楷 GB 屏幕版 97 个切片）；
  - `黑体`：`Inter` + 系统无衬线（零额外中文字体流量）。
  - 所有 UI 控件保持无衬线，未切换到的中文字体 0 字节按需加载。
- **构建时 KaTeX 数学排版**：严格 `throwOnError` 编译所有 `$...$` 与 `$$...$$`，内置公式防溢出滚动与折叠解答框 `:::solution` / `:::hint`。
- **双模式 / 单模式自适应**：
  - `dualReadingStyle: true`：默认 SSR 渲染 `content-explained/`（讲解式），按需异步加载内容指纹化的 `content/`（公理版）JSON 视图；
  - `dualReadingStyle: false`：单模式仅编译 `content/`，自动隐藏切换器且不生成 `assets/views/`。
- **首次提及概念速览卡**：每页仅在可见正文（优先于折叠解答）首次出现概念时注入 `.concept-ref`，支持按学科在 `site.config.json` 中配置防误拆词表。
- **划词笔记本 + 可选 D1 云端同步**：支持划词摘录、批注、Markdown / JSON 导出，以及基于口令哈希分区的 Cloudflare Workers + D1 LWW 跨设备同步。
- **内置严格 QA 门禁与内容指纹化**：SHA-256 8 位指纹命名静态资源 + 非重叠 `immutable` `_headers`，自动校验公式、链接、WOFF2 文件头、零孤立字体与无障碍属性。

---

## 快速开始：新建一门课程站

需要 Node.js `>= 20`。

```bash
# 方式一：直接从本底座初始化新课程目录
npx github:CheemsaDoge/notes-site-base init my-course --title "线性代数精讲" --slug linear-algebra

# 若只需要单版本讲义（不区分讲解式与公理版），追加 --single-mode：
npx github:CheemsaDoge/notes-site-base init my-course --title "大学物理笔记" --slug physics --single-mode

cd my-course
npm install
npm run check
```

初始化后的课程仓库结构极其精简：

```text
my-course/
├── site.config.json       # 站点名称、命名空间、单/双模式、学科词表与样式覆盖
├── data/
│   ├── sitemap.json       # 三级目录（Part -> Chapter -> Page）与考点导览
│   └── concepts.json      # 概念速览卡定义（支持行内与行间 KaTeX）
├── content/               # 讲义 Markdown（双模式下为公理版，单模式下为唯一正文）
├── content-explained/     # 讲解式 Markdown（仅 dualReadingStyle: true 时需要）
├── styles/custom.css      # 可选：覆盖主题强调色等 CSS 变量
├── src/worker.mjs         # 可选：3 行接入 Cloudflare Workers 云同步
└── cloudflare.config.ts   # 可选：Cloudflare Workers + D1 部署配置
```

---

## `site.config.json` 配置说明

```json
{
  "site": {
    "title": "课程讲义站",
    "shortTitle": "课程精讲",
    "subtitle": "Interactive Study Notes",
    "description": "面向移动阅读与期末复习优化的微课化静态讲义站。",
    "brandMark": "N",
    "heroBadge": "交互式分层讲义 · 概念速览 · 划词笔记 · 云端同步",
    "footerNote": "纯静态离线友好学习站",
    "exportPrefix": "学习讲义",
    "lang": "zh-CN"
  },
  "storage": {
    "prefix": "my-course:v1",
    "themeKey": "my-course-color-scheme",
    "syncHashPrefix": "my-course-sync-v1:"
  },
  "features": {
    "dualReadingStyle": true,
    "defaultReadingStyle": "explained",
    "defaultFontTheme": "serif",
    "collapsibleCallouts": true,
    "readingStyleLabels": {
      "explained": "讲解式",
      "axiomatic": "公理版",
      "explainedHint": "从直觉与例子出发循序推导",
      "axiomaticHint": "精简定义与考纲标准证明"
    },
    "styleAudit": {
      "forbidEmDash": false
    }
  },
  "paths": {
    "dataDir": "data",
    "contentDir": "content",
    "explainedDir": "content-explained",
    "outDir": "dist",
    "extraStyles": []
  },
  "concepts": {
    "nonNegatedTerms": [],
    "inertCompoundBlockers": [],
    "boundaryGuards": {},
    "suffixGuards": []
  },
  "examOverview": {
    "groupLabels": {}
  }
}
```

- **主题微调**：在课程目录放入 `styles/custom.css`（或在 `paths.extraStyles` 中列出相对 CSS 路径），构建器会自动对其指纹化并排在 `04-mobile.<hash8>.css` 之后加载。
- **命名空间隔离**：不同课程站应使用不同的 `storage.prefix`、`storage.themeKey` 与 `storage.syncHashPrefix`，避免同域下本地存储或云端同步空间冲突。

---

## 一键同步底座更新

课程站在 `package.json` 中通过 npm Git 依赖锁定底座：

```json
{
  "dependencies": {
    "notes-site-base": "github:CheemsaDoge/notes-site-base"
  }
}
```

当 `notes-site-base` 发布样式优化、交互升级或构建修复后，在任意课程仓库执行：

```bash
npm update notes-site-base
npm run check
```

---

## CLI 命令一览

| 命令 | 说明 |
| --- | --- |
| `notes-site build` | 构建静态站到 `dist/`（支持 `--root`、`--config`、`--out-dir`、`--allow-missing-explained`） |
| `notes-site verify` | 对 `dist/` 执行全部 QA 门禁（KaTeX、链接、概念注入、WOFF2 文件头、零孤立字体、`_headers`） |
| `notes-site check` | 依次执行 `build` 与 `verify` |
| `notes-site prepare-deploy` | 打包 Worker ESM 模块与 `dist/` 静态资产至 Cloudflare Build Output v1 目录 |
| `notes-site init <dir>` | 从 `starter/` 初始化新课程站（支持 `--title`、`--slug`、`--brand-mark`、`--single-mode`） |

---

## 部署到 Cloudflare Workers + D1（可选）

若仅需纯静态托管，直接将 `dist/` 发布到任意静态托管（Cloudflare Pages、GitHub Pages、Netlify 等）即可。若需开启 `/api/sync` 跨设备云端同步：

1. 在 Cloudflare 创建一个 D1 数据库并执行初始化迁移 `node_modules/notes-site-base/migrations/0001_init.sql`。
2. 在课程仓库的 `cloudflare.config.ts` 中填入你的 D1 数据库 `name` 与 `id`（勿提交任何密钥或个人 Token）。
3. 在课程仓库的 `src/worker.mjs` 中通过 `createWorker({ syncHashPrefix: "<你的前缀>" })` 导出 Worker。
4. 构建并部署：

```bash
npm run check
npm run prepare-deploy
# 使用 Cloudflare CLI 部署预构建产物（具体命令依所用 CLI 版本而定）
```

---

## 本地开发与测试（底座自身）

```bash
npm install
npm test
```

`npm test` 会运行全部 Worker 云同步单元测试（含默认与自定义 `syncHashPrefix` 隔离测试）以及 `starter/` 双模式、单模式 CLI、`extraStyles` 与 `forbidEmDash` 端到端冒烟测试。

## 开源许可

本项目代码采用 [MIT License](./LICENSE)。内置开源库与自托管字体许可清单见 [THIRD_PARTY_LICENSES.md](./THIRD_PARTY_LICENSES.md)。
