# Third-Party Open-Source Licenses

`notes-site-base` bundles or depends on the following open-source libraries and fonts. All licenses are permissive and permit self-hosting and redistribution.

## Build-Time & Runtime Libraries

| Package | License | Purpose |
| --- | --- | --- |
| [KaTeX](https://katex.org/) (`katex`) | MIT | Build-time LaTeX math typesetting & math webfont assets |
| [markdown-it](https://github.com/markdown-it/markdown-it) (`markdown-it`) | MIT | CommonMark Markdown parser |
| [cheerio](https://cheerio.js.org/) (`cheerio`) | MIT | Build-time HTML DOM transformation & verification |

## Self-Hosted Fonts

All reading and UI fonts are self-hosted inside the generated static output (`dist/assets/fonts/` and `dist/assets/katex/fonts/`) with zero external CDN requests.

| Font | Upstream Package | License |
| --- | --- | --- |
| **Source Serif 4** | `@fontsource-variable/source-serif-4` | SIL Open Font License 1.1 (OFL-1.1) |
| **Noto Serif SC** (思源宋体) | `@fontsource-variable/noto-serif-sc` | SIL Open Font License 1.1 (OFL-1.1) |
| **LXGW WenKai Screen** (霞鹜文楷屏幕阅读版) | `lxgw-wenkai-screen-webfont` | Font: SIL Open Font License 1.1 (OFL-1.1); npm webfont packaging: MIT |
| **Inter** | Self-hosted Latin variable subset (`src/styles/fonts/inter-latin-wght-normal.woff2`) | SIL Open Font License 1.1 (OFL-1.1) |
| **KaTeX Math Fonts** | Bundled with `katex` | SIL Open Font License 1.1 (OFL-1.1) |
