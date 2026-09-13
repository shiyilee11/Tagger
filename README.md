<p align="center">
  <img src="./public/tagger-icon.svg" width="128" alt="Tagger 图标" />
</p>

<h1 align="center">Tagger</h1>

<p align="center">轻量、本地优先的 CSV/TSV 人工标注器</p>

## 当前能力

- 导入 CSV/TSV，支持拖动选择、行列选择、编辑模式和标注模式。
- 单元格、范围、整行、整列、整表打标签。
- 标签包含名称、定义、颜色和可录入组合快捷键。
- 表头筛选支持按值多选、反选和按标签筛选，多个条件可以叠加。
- 标签栏支持左右上下吸附、拖动调整尺寸和浮动缩放。
- 大表格使用 Worker 解析和可视行渲染，避免一次渲染全部行。
- 十个存档位，支持批量导入、删除确认和中途离开后继续标注。
- `Cmd/Ctrl+S` 保存，撤销、重做、复制、粘贴和搜索等常用操作可用。

## 标签文件

CSV/TSV 本身不保存颜色和标签。Tagger 使用同名的 `.tags.json` 保存标签定义和标注信息：

```text
records.csv
records.tags.json
```

标签文件使用 `tagger.tags/v1` 格式，行标注使用从零开始的 `row-0`、`row-1`，单元格标注使用表头名称定位。CSV 与标签 JSON 可以被普通 CSV/JSON 工具分别读取，并按行号合并。

在存档页选择“恢复 CSV + 标签”，可以同时选择 CSV/TSV 和同名 `.tags.json`；也可以直接导入 Tagger 导出的 `.tagger.zip`。恢复后会占用一个存档位，并在 Tagger 中继续显示标签。

“新建标注”只导入表格，创建一个没有标签的新存档。

## 启动

安装依赖：

```bash
npm install
```

浏览器开发版：

```bash
npm run dev
```

浏览器版只建议打开小于 3 MB 的文件。更大的文件会被拦截，请使用桌面安装版。

桌面开发版：

```bash
npm run tauri dev
```

构建安装包：

```bash
npm run tauri build
```

## 项目结构

```text
src/
  App.tsx                 React 应用和交互逻辑
  App.css                 界面样式
  csvParser.ts            CSV/TSV 流式解析
  csvParser.worker.ts     后台解析 Worker
  types/index.ts          数据类型
  main.tsx                前端入口
src-tauri/
  src/main.rs             Tauri 命令和本地文件能力
  tauri.conf.json         桌面应用配置
package.json              前端和 Tauri 命令
```

## 常用快捷键

| 快捷键 | 操作 |
| --- | --- |
| `Shift+L` | 切换标注/编辑模式 |
| `Cmd/Ctrl+S` | 保存 |
| `Cmd/Ctrl+Z` | 撤销 |
| `Cmd/Ctrl+Shift+Z` | 重做 |
| `Cmd/Ctrl+K` | 聚焦搜索 |
| `Cmd/Ctrl+A` | 选择整表 |
| `Delete` | 标注模式移除标签，编辑模式清空内容 |
