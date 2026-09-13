<p align="center">
  <img src="./public/tagger-icon.svg" width="128" alt="Tagger 图标" />
</p>

<h1 align="center">Tagger</h1>

<p align="center">轻量、本地优先的 CSV/TSV 数据标注器</p>

Tagger 用普通表格查看数据，用快捷键对单元格、行、列或整张表添加标签。标签定义、颜色和标注位置保存在配套 JSON 中，表格仍保持普通 CSV/TSV 格式。

详细功能说明见 [CURRENT_FEATURES.md](./CURRENT_FEATURES.md)。

## 快速开始

环境要求：Node.js 18+、npm。构建桌面版还需要 Rust 和 Cargo。

先安装依赖：

```bash
npm ci
```

### 方式一：浏览器开发版

```bash
npm run dev
```

在终端打开 Vite 输出的本地地址。浏览器版适合小于 3 MB 的 CSV/TSV；大文件请使用桌面版。

### 方式二：Tauri 桌面开发版

```bash
npm run tauri dev
```

桌面版和浏览器版使用同一份 `src/` 前端代码，操作和显示保持一致。Tauri 开发服务器固定使用 `5173` 端口；如果该端口被其他项目占用，请先停止其他开发服务器再启动。

## 基本流程

1. 进入存档界面，导入 CSV/TSV。
2. 默认进入标注模式，选择单元格、拖动范围、单击行号或表头。
3. 在右侧创建标签，填写名称、定义、颜色，并点击快捷键区域后直接按下组合键。
4. 点击标签或按标签快捷键进行标注；仅按 `Shift+快捷键` 可移除标签。
5. 使用表头下拉筛选，或右上角“列”菜单隐藏不需要参考的列。
6. 按 `Cmd/Ctrl+S` 保存，右上角导出 CSV、标签 JSON 或配套 ZIP。

## 两种模式

`Shift+L` 在两种模式之间切换：

- **标注模式**：表格文本锁定，快捷键和 `Delete` 只作用于标签，显示标签栏。
- **编辑模式**：隐藏标签栏，双击或按 `Enter` 编辑单元格，`Delete` 清空文本。

## 筛选与选择

- 表头下拉面板支持按值筛选和按标签筛选。
- 按值支持文本搜索、值列表、正选、反选、全选、全不选和反转勾选。
- 不同列的筛选条件可以叠加。
- 单击或拖动选择单元格；单击行号选行，单击表头选列。
- 列宽可以拖动调整；“列”菜单支持隐藏、反选和全部显示。

## 文件格式

Tagger 不把标签颜色写进 CSV/TSV 本体。配套文件通常是：

```text
records.csv
records.tags.json
```

标签 JSON 保存标签定义和 `rows`、`cells`、`columns`、`dataset` 四种标注范围。单独打开 CSV 只能看到原始表格；恢复标签时需要同时导入 CSV 与 JSON。

选择“CSV + 标签”会生成 `.tagger.zip`，其中包含表格、`.tags.json` 和标签样例 JSON。这个 ZIP 可以从存档界面恢复，也可以解压后分别交给普通表格工具或 JSON 工具读取。

## 存档与导出

- 最多 10 个存档位，支持拖入、批量导入、恢复和删除确认。
- 恢复入口支持单个 CSV + 标签 JSON，或包含二者的 `.tagger.zip`。
- 存档界面可以勾选多个存档批量导出。
- 导出 CSV 或 CSV + 标签后，会询问是否清理当前存档。

## 构建安装包

```bash
npm run tauri build
```

安装包输出在 `src-tauri/target/release/bundle/`。请在目标操作系统上分别构建和测试。也可以使用：

```bash
./dev.sh
./build.sh
```

## 常用快捷键

| 快捷键 | 操作 |
| --- | --- |
| `Shift+L` | 切换标注/编辑模式 |
| `Cmd/Ctrl+S` | 保存 |
| `Cmd/Ctrl+O` | 打开存档界面 |
| `Cmd/Ctrl+Z` | 撤销 |
| `Cmd/Ctrl+Shift+Z` 或 `Cmd/Ctrl+Y` | 重做 |
| `Cmd/Ctrl+K` 或 `Cmd/Ctrl+F` | 聚焦搜索 |
| `Cmd/Ctrl+A` | 选择整表 |
| `Delete` / `Backspace` | 标注模式移除标签，编辑模式清空文本 |
| `Escape` | 关闭浮层并清除选择 |

## 项目结构

```text
src/                    React 前端、表格、筛选和标签交互
src-tauri/src/main.rs   Tauri 桌面文件读写和标签保存
src/csvParser.ts        CSV/TSV 解析
src/csvParser.worker.ts 后台解析 Worker
public/tagger-icon.svg  页面和桌面应用图标源文件
```
