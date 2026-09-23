# 参与开发

## 跑起来

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # 单元测试
npm run test:e2e     # 端到端（需要 dev server 在跑）
```

浏览器测试使用 Playwright 与 Chromium。修改交互后运行相关用例。测试期间保持源码稳定，避免热更新影响页面。

## 开发约定

几何判断使用可测试的规则：`specCompat.ts` 检查共同边，`bracketSeat.ts` 计算槽线落位，`analysis.ts` 检查干涉。

几何问题标记后仍允许继续编辑。目录不为没有共同边的 2020 与 4040 组合生成角部连接件。

**绘制与选择。** 选择型材规格后点击绘制，放下型材后点击选择。

**界面说明。** 工具栏使用图标和 tooltip，详细操作说明放在文档中。

## 提交

- 提交信息写**做了什么、为什么**。
- 一个提交做一件事。
- 改了行为就改测试；加了规则就加测试。

## 代码

- TypeScript strict，`npm run build` 必须过。
- 注释解释设计原因，避免重复代码含义。
- 新的几何判断放 `src/utils/`，纯函数，不碰 store，便于独立测试。

## 报问题

说清楚：画的是什么、期望什么、实际什么。能附上导出的工程 JSON 或分享链接最好。
