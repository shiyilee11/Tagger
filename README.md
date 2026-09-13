![Tagger 图标](./public/tagger-icon.svg)

# Tagger

轻量、本地优先的 CSV/TSV 数据标注器。

Tagger 使用普通表格查看数据，用快捷键对单元格、范围、行、列或整张表添加标签。表格和标签分开保存，方便继续编辑、恢复和交给其他工具读取。

详细功能见 [CURRENT_FEATURES.md](./CURRENT_FEATURES.md)。

## 快速开始

环境要求：Node.js 18+、npm。桌面版开发和打包还需要 Rust、Cargo。

先安装依赖：

```bash
npm ci
```

### 方式一：浏览器版

```bash
npm run dev
```

打开终端显示的本地地址。浏览器版适合小于 3 MB 的 CSV/TSV；大文件请使用桌面版。

### 方式二：桌面版

```bash
npm run tauri dev
```

桌面版和浏览器版共用同一份 `src/` 前端代码，显示和操作保持一致。桌面版使用原生文件选择器，保存时可以写回原 CSV/TSV。

## 基本使用

1. 在存档界面导入 CSV/TSV。恢复已有标注时，点击“导入 ZIP”，选择配套 ZIP；也可以同时选择 CSV/TSV 与标签 JSON。
2. 默认进入标注模式。选择单元格、拖动范围、点击行号或表头，再点击标签或按标签快捷键。
3. 标签包含名称、定义、颜色和快捷键。点击快捷键区域后，直接按下组合键即可录入，例如 `Cmd+1`。
4. `Shift+L` 切换标注模式和编辑模式。标注模式锁定表格文本；编辑模式隐藏标签栏并允许修改单元格内容。
5. 表头按钮打开筛选面板，可按值或按标签筛选；值筛选支持搜索、勾选、正选、反选，多个列条件可以叠加。
6. 按 `Cmd/Ctrl+S` 保存。右上角导出 CSV、标签 JSON 或配套 ZIP。

## 存档和保存

最多 10 个存档位。工作区变化会同步到当前存档，返回时不会自动删除存档；导出 CSV 或配套 ZIP 后会询问是否清理当前存档。

- **浏览器版**：存档保存在当前网站的浏览器数据中，小存档优先使用 `localStorage`，较大存档或容量不足时使用 IndexedDB。刷新或重新打开同一地址通常可以恢复；清除网站数据、关闭无痕窗口、换浏览器或设备，都可能丢失存档。重要工作请导出配套 ZIP。
- **桌面版**：从“导入 CSV/TSV”按钮选择原文件后，保存会写回原文件，并在同目录生成 `文件名.tags.json`。存档槽的索引和副本保存在桌面应用的本地 WebView 数据中；清除应用数据会清空存档槽，但不会自动删除原 CSV 或标签 JSON。
- **副本导入**：桌面拖入文件或从 ZIP 恢复的内容没有原文件路径，需要通过导出得到文件；要写回原 CSV，请使用导入按钮选择原文件。

## 文件格式

标签不写入 CSV/TSV 本体：

```text
records.csv
records.tags.json
```

标签 JSON 保存标签定义和 `rows`、`cells`、`columns`、`dataset` 标注。单独打开 CSV 只能看到表格内容；恢复标签时需要同时导入 CSV/TSV 和对应 JSON。

选择“CSV + 标签”会生成“原文件名 + `.zip`”的配套包，例如：

```text
records.csv.zip
  01-records/
    records.csv
    records.tags.json
    tagger-tags-template.json
```

ZIP 内的 CSV/TSV 是普通表格文件，标签定义和标注位置在 JSON 中。配套 ZIP 可以重新导入 Tagger，也可以解压后分别交给表格工具和 JSON 工具读取。

## 常用快捷键

| 快捷键                               | 操作                |
| --------------------------------- | ----------------- |
| `Shift+L`                         | 切换标注/编辑模式         |
| `Cmd/Ctrl+S`                      | 保存                |
| `Cmd/Ctrl+O`                      | 打开存档界面            |
| `Cmd/Ctrl+Z`                      | 撤销                |
| `Cmd/Ctrl+Shift+Z` 或 `Cmd/Ctrl+Y` | 重做                |
| `Cmd/Ctrl+K` 或 `Cmd/Ctrl+F`       | 聚焦搜索              |
| `Cmd/Ctrl+A`                      | 选择整表              |
| `Delete` / `Backspace`            | 标注模式移除标签，编辑模式清空文本 |
| `Escape`                          | 关闭浮层并清除选择         |

## 构建安装包

```bash
npm run tauri build
```

安装包输出在 `src-tauri/target/release/bundle/`。请在目标操作系统上分别构建和测试。仓库也提供：

```bash
./dev.sh
./build.sh
```

## 项目结构

```text
src/                    React 前端、表格、筛选和标签交互
src-tauri/src/main.rs   Tauri 桌面文件读写和标签保存
src/csvParser.ts        CSV/TSV 解析
src/csvParser.worker.ts 后台解析 Worker
public/tagger-icon.svg  页面和 README 使用的图标
```

当前浏览器版会拦截 3 MB 及以上文件；桌面版虽然使用 Worker/原生解析和可视行渲染，但数据仍会整体占用内存，超大文件需要在目标设备上实测。