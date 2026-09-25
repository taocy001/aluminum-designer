# 设计文档

铝型材框架设计器：浏览器里画铝型材框架，画完直接出下料清单。
React 19 + @react-three/fiber（Three.js）+ Zustand + Vite，TypeScript strict。

这份文档描述**当前状态**：数据模型、几何语义、交互模型、模块划分。
功能清单与用法在 [`FEATURES.md`](FEATURES.md)，未做的计划在
[`ROADMAP.md`](ROADMAP.md)。

---

## 1. 数据模型

**中心线模型。** 一根型材存的是中心线：`position`（起点，不是中心）+ `quaternion`
（局部 +Z 指向终点方向）+ `length`。截面由规格推出（2020 / 2040 / 3030 / 3040 / 4040）。
中心线是"人想的长度"；渲染和清单用的是修剪后的真实几何，两者经常不一样——
下料长度才是要切的那一刀（见 §3）。

四类零件，都在 `src/store/useStore.ts`：

| 类型 | 关键字段 | 说明 |
|---|---|---|
| `ProfileData` | spec, length, position, quaternion | 型材 |
| `ConnectorData` | type, series, position, quaternion | 连接件（14 种，见 `connectorCatalog.ts`）；位置朝向由落位代码算 |
| `PanelData` | width, height, thickness, material, 中心 + 朝向 | 板件。按自身尺寸建模，不绑定开口——板裁定了就不该被框架改动悄悄改尺寸 |
| `FittingData` | kind(drawer/door), width/height/depth(净开口), hinge, overlay, open, stacked | 门与抽屉是**构件**：知道自己的开口，能重新裁切，记着开合度。局部 +Z 是开启方向 |

所有零件都有 `locked`：锁定件仍可见、仍参与吸附与清单，但不被移动或删除。

**工程文件**：JSON，`version: 3`（`Sidebar.tsx` 导出，`projectFile.ts` 读写），
旧版本由 `migrate.ts` 迁到当前语义。分享链接是同一数据按列打包 + deflate +
base64url 压进 URL 片段，不经过服务器（`shareLink.ts`）。

## 2. 坐标与单位

- 右手系，**Y 轴朝上**，单位毫米。
- 型材局部 +Z 是拉伸方向；`position` 是起点。
- 板件局部：宽 X、高 Y、厚 Z。
- 构件（门/抽屉）局部：X 横跨开口、Y 向上、+Z 朝外（拉开/打开的方向）。

## 3. 核心几何语义

这几条规则是"画完能下料"的全部依据，每条都有单元测试。

**接头修剪**（`jointUtils.computeTrims`）
贯通优先级 Y（立柱）> X > Z（侧栏可切换为横梁贯通）。低优先级构件在接头处对接
（切短半个对方截面），高优先级构件在角接处延伸到对方外表面。T 接头端点落在对方
中线内部即对接。容差接头：端点落在对方截面 ±1mm 内即成接头，多/少几毫米被吸收。
输出每端 trim 与 cutLength——**下料长度 ≠ 中心线长度**。

**落地规则**（`profileFactory.floorY`）
水平构件中心线不低于半截面高（2020 → y≥10），从地面起画自动抬升；立柱从 y=0 起。
落地是**钳制**不是拒绝；属性面板手输坐标是明确意图，不钳制。

**贴面装配**（`specCompat.ts` + `faceAlign.ts`）
两根型材端面对接能用角码连接，当且仅当：① 截面有一条**共同边**（2020 挂 4040 没有）；
② 实际对接面**共面**。新画的型材落下去会自动横向平移让面共面（先试翻转 90°，
翻转不行才平移），已有构件不动，所以不级联。2040 立着放和躺着放是两种构件，
截面朝向是一等属性（`rollProfile`）。

**角码按槽线落位**（`bracketSeat.ts`）
20 面一条槽在正中；40 面两条在 ±10，正中是实心铝——摆在 40 面正中拧不上。
落位平面是两根方向的叉积且必须两者共有；平面内偏移由对方的槽线决定。
`auditBrackets` 核对每个已装角码是否真的拧得上。

**干涉检查**（`analysis.findConflicts`）
型材、连接件、板件、门与抽屉四类一起，OBB 分离轴判定（`obb.ts`）。
构件按它实际由哪些板组成、在当前开合位置上判定（`fittingGeometry.fittingSolids`）。
干涉标红并指出位置，**不阻止继续画**——先摆对，再调整。

**可动构件**（`fittingGeometry.ts` / `fittingOps.ts`）
抽屉箱体每侧让 12.5mm 滑轨间隙；抽面/门板按盖法（全盖/半盖/嵌入）逐边定尺寸，
叠放抽屉相邻边留 3mm 缝（`stacked`）。门的铰链类型与开启角（95°–180°）可选，
开合模拟参与相撞检测。门只能朝外开，朝向由所在柜体就地判断。

## 4. 交互模型

**没有模式，只有"手里拿着什么"。** `useToolStore.held`：点侧栏规格/连接件即拿在手里，
点画布落点；再点一次或 Esc 放下。空手点击即选中。三键固定：左键拖空白转视角、
右键平移、滚轮缩放，与手里拿什么无关。

**拾取两条规则，有先后**（`frontmost.ts` + `screenPick.ts` + `PointerRouter.tsx`）：
① 画面上画的是谁，点中的就是谁（对真实网格做射线检测，命中的直接提到最前）；
② 都没正对命中时才按屏幕距离与深度决胜。Tab 在重叠处循环候选。
代价要说清楚：门关上就挡住框架，这时点中的是门——所以侧栏有"收起柜门与抽屉"开关。

**编辑**：拖动（含 Gizmo 单轴）、旋转（Gizmo 圆弧 90°，支点 `P` 切换）、
端面拉伸、方向键微调；手势中途敲数字精确定值。镜像按整图中心面、阵列沿轴；
一次手势一条撤销（上限 50 步）。

## 5. 状态层次

```
useStore（zustand + persist → localStorage）
  profiles / connectors / panels / fittings + 撤销栈 + 操作日志
useToolStore（运行时，不持久化）
  held / 选择集 / 绘制态 / 拖拽态 / 视图开关
```

几何判断全部是 `src/utils/` 下的纯函数，不碰 store，所以每条规则都测得到。

## 6. 模块地图

**`src/components/`** — App（布局与快捷键）、Viewport（Canvas 与相机）、
DrawingHandler（绘制事件）、PointerRouter（统一指针路由与拾取）、DragHandler（拖动/拉伸）、
TransformGizmo（移动/旋转手柄）、ResizeHandles（端面拉伸箭头）、QuickMenu（空格快捷盘）、
Profile / Connector / Panel / Fitting（四类零件渲染）、SnapMarker（屏幕等大吸附标记）、
TextSprite / LabelLayout / FrameDimensions（标注）、SuggestionGhost（建议预览）、
Sidebar（组件库/属性/清单）、Gestures（触屏手势）、Tooltip。

**`src/utils/`**（全部纯函数）

| 文件 | 职责 |
|---|---|
| geometryCore / jointUtils | 中心线几何、接头修剪 |
| profileShapes / profileFactory / specUtils | 截面形状、创建与落地、规格表 |
| pickUtils / screenPick / frontmost | 起点拾取与轴向解析、屏幕空间候选、前景命中 |
| dragSnap / faceAlign / editOps | 拖动吸附、贴面对齐与翻转、编辑操作（镜像/阵列/旋转/锁定） |
| specCompat / repairJoints | 可装配性判定、一键修接头（先转再挪，每步打分） |
| bracketSeat / connectorCatalog / connectorFit / autoConnect | 角码落位与审计、连接件目录、朝向推断、一键连接 |
| panelOps / shelfSupport | 板件生成与编辑、层板承托检查 |
| fittingGeometry / fittingOps / runnerMount | 构件几何与开合、构件生成、滑轨安装面检查 |
| analysis / obb | 干涉检查（OBB 分离轴） |
| deflection / assembly | 挠度校核、装配顺序拓扑 |
| bom / nesting / dxf / step | 物料清单、原料排料、DXF 图纸、STEP 实体 |
| projectFile / shareLink / migrate | 工程文件、分享链接、旧版本迁移 |
| templates / measure / suggest(·Gate/·Ops) | 起步模板、测量、建议下一根 |
| opLog / translations | 操作日志、中英文案 |

## 7. 测试

- `npm test`：vitest 单元测试（`src/__tests__`），覆盖每条几何规则与示例自检
  （`examples.test.ts` 读 `examples/` 全部工程：零干涉、接头全部可装、角码落位正确）。
- `npm run test:e2e`：Playwright 无头 Chromium（`e2e/`，391 个用例），
  用真实渲染结果模拟点击。跑 e2e 时不要改源码——热更新会换页面。
- 开发模式下 `window.__aluframe` 暴露测试钩子（store / camera / worldToClient /
  pickAt / conflicts / trims 等）。

## 8. 构建与部署

```bash
npm install && npm run dev    # 开发，:5173
npm run build                 # tsc + vite build → dist/
docker compose up -d --build  # 多阶段构建，nginx 托管，:4174
```

Dockerfile 两阶段：`node:20-alpine` 编译，`nginx:alpine` 托管静态文件。
