# Aluminum Designer — 设计文档

> 版本：v2.0（v1.0 于 2026-03-18；v2.0 重构于 2026-09-20，见第 10 章）
> 日期：2026-09-20

---

## 目录

1. [项目概述](#1-项目概述)
2. [技术栈](#2-技术栈)
3. [架构设计](#3-架构设计)
4. [核心模块详解](#4-核心模块详解)
5. [交互流程](#5-交互流程)
6. [编译与部署](#6-编译与部署)
7. [Bug 记录与修复](#7-bug-记录与修复)
8. [业界对比分析](#8-业界对比分析)
9. [下一步优化方向](#9-下一步优化方向)
10. [v2.0 可施工重构](#10-v20-可施工重构)

---

## 1. 项目概述

Aluminum Designer 是一款运行在浏览器中的铝型材框架设计工具，允许用户在三维视口中快速绘制铝型材（20系列、30系列、40系列）并放置连接件，最终导出物料清单（BOM）。

**核心功能：**
- 三维视口：轨道相机（旋转/缩放/平移）
- 绘制模式：点击起点→终点，自动对齐 X/Y/Z 轴
- 吸附系统：端点吸附 + 轴向约束 + 网格对齐
- 碰撞检测：防止型材重叠（AABB + 一维区间两级检查）
- 型材拖拽：导航模式下拖移型材到新位置
- 14 种连接件：L 角码、T 角码、合页、轴承座等
- 持久化：设计数据保存至 localStorage，刷新不丢失
- 双语：中文 / English 界面切换
- BOM 导出：CSV 格式

---

## 2. 技术栈

| 层次 | 技术 | 版本 | 说明 |
|------|------|------|------|
| UI 框架 | React | 19 | 函数组件 + Hooks |
| 3D 渲染 | Three.js | 0.183 | WebGL 渲染引擎 |
| R3F | @react-three/fiber | 9.5 | React 绑定 Three.js |
| R3F 工具 | @react-three/drei | 10.7 | OrbitControls、Grid、Line 等 |
| 状态管理 | Zustand | 5.0 | 全局状态 + persist 中间件 |
| 样式 | TailwindCSS | 4.0 | 原子化 CSS |
| 图标 | lucide-react | 0.577 | SVG 图标库 |
| 构建 | Vite | 6.0 | 开发服务器 + 生产构建 |
| 类型 | TypeScript | 5.7 | 全量类型检查 |
| 容器 | Docker + nginx | alpine | 生产部署 |

---

## 3. 架构设计

### 3.1 目录结构

```
src/
├── main.tsx                  # 应用入口
├── App.tsx                   # 根组件（布局、快捷键、状态展示）
├── components/
│   ├── Viewport.tsx          # Three.js Canvas 容器 + 相机控制
│   ├── DrawingHandler.tsx    # 绘制交互（大球体事件捕获 + 射线平面求交）
│   ├── DragHandler.tsx       # 拖拽交互（canvas DOM 原生事件）
│   ├── Profile.tsx           # 单根型材渲染 + 点击触发拖拽
│   ├── Connector.tsx         # 连接件渲染（14 种 3D 几何）
│   └── Sidebar.tsx           # 侧边栏（规格选择、属性面板、BOM）
├── hooks/
│   └── useDrawTool.ts        # 绘制逻辑（吸附、轴对齐、碰撞校验、放置）
├── store/
│   ├── useStore.ts           # 数据 store（型材、连接件、选中状态）
│   └── useToolStore.ts       # 工具 store（绘制状态、拖拽状态、视图模式）
└── utils/
    ├── profileShapes.ts      # 型材截面 2D 形状生成（T 槽细节）
    ├── snapUtils.ts          # 吸附、轴对齐、AABB 碰撞检测
    └── translations.ts       # 中英文翻译字典
```

### 3.2 状态层次

```
┌─────────────────────────────────────────┐
│  useStore（持久化至 localStorage）        │
│  profiles[]  connectors[]  selectedId   │
└─────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│  useToolStore（运行时，不持久化）          │
│  viewMode  isDrawing  startPoint        │
│  currentPoint  snapPoint  activeSpec    │
│  isDragging  dragProfileId  ...         │
└─────────────────────────────────────────┘
```

### 3.3 坐标约定

- **世界坐标**：Three.js 默认右手系，Y 轴朝上
- **型材本地坐标**：
  - 局部 Z 轴 = 拉伸方向（ExtrudeGeometry 沿 +Z 拉伸）
  - 局部 X/Y = 截面平面
- **四元数**：`setFromUnitVectors(Z, direction)` 将局部 Z 旋转到世界中的目标方向
- **位置存储**：型材的 `position` 是起点（start endpoint），不是中心

---

## 4. 核心模块详解

### 4.1 型材截面生成 — `profileShapes.ts`

根据规格字符串（如 `'2040'`）生成带 T 槽细节的 2D `THREE.Shape`，
再由 `ExtrudeGeometry` 沿 Z 轴拉伸深度=1（后通过 `scale.z = length` 缩放到实际长度）。

**规格解析：**
```ts
const w = Number(spec.substring(0, 2))  // 前两位 → 宽度 mm
const h = Number(spec.substring(2)) || w  // 后两位 → 高度，默认等于宽度
```

支持规格：`2020`（20×20）、`2040`（20×40）、`3030`、`3040`、`4040`。

**T 槽参数：**
- 槽口半宽 `sw`：20系 = 3mm，30/40系 = 4mm
- 槽深 `sd`：20系 = 6mm，30/40系 = 9mm
- 每面槽数 `nx/ny = floor(dim/20)`

**路径方向：** 逆时针（CCW），Three.js ExtrudeGeometry 要求外轮廓为 CCW。

---

### 4.2 吸附与碰撞 — `snapUtils.ts`

#### `getProfileEndpoints(profile)`
从 position（起点）+ quaternion（旋转）计算型材的起点和终点 Vector3。

```
end = start + rotate(Z, quat) * length
```

#### `findSnapPoint(point, profiles, threshold, exclude?)`
遍历所有型材的两个端点，返回距离 `point` 最近且在 `threshold` 内的端点。
`exclude` 参数用于排除起点自身（防止零长度型材）。

#### `snapToAxis(start, end)`
将 end 投影到距 start 最近的轴方向（X/Y/Z 三选一），确保型材横平竖直。

```
d = end - start
取 |dx|、|dy|、|dz| 中最大的轴，沿该轴方向截取端点
```

#### `wouldOverlap(candidate, existing[])` — 两级碰撞检测

**Case 1 — 同轴同直线：1D 区间重叠**
- 判断两根型材是否共轴（同方向 + 垂直偏移 ≤ 2mm）
- 若共轴，只比较沿轴的 1D 区间是否重叠（允许端对端接触，TOUCH_EPS=2mm）

**Case 2 — 其他情况：AABB 三维包围盒相交**
- 计算每根型材的世界空间 AABB（考虑截面实际 w×h 尺寸）
- 若 AABB 不相交 → 无碰撞
- 若相交 → 检查**角接头例外**：两根非共轴型材共享一个端点（距离<2mm）视为合法角接头，允许小范围 AABB 重叠

```
AABB计算：
  min.x = pos.x - |lx.x|*hw - |ly.x|*hh + min(0, dir.x*len)
  max.x = pos.x + |lx.x|*hw + |ly.x|*hh + max(0, dir.x*len)
  （y, z 同理）
```

---

### 4.3 绘制交互 — `DrawingHandler.tsx`

#### 事件捕获机制
在绘制模式下渲染一个**半径 8000mm 的透明反面球体**（`THREE.BackSide`）。
射线从相机出发，打到球体内表面，总能得到一个交点，与相机角度无关。

```tsx
<mesh onPointerDown={onPointerDown} onPointerMove={onPointerMove}>
  <sphereGeometry args={[8000, 8, 6]} />
  <meshBasicMaterial transparent opacity={0} side={THREE.BackSide} />
</mesh>
```

#### 射线-平面求交
两种绘制平面动态切换：

| 模式 | 平面 | 触发条件 |
|------|------|----------|
| 水平 | Y=startPoint.y 的 XZ 平面 | 鼠标左右移动（`dx > dy*2`）|
| 垂直 | 过 startPoint、法向量指向相机 XZ 分量的竖直平面 | 鼠标斜向移动（`dy > dx*0.5`）|

**垂直平面法向量计算：**
```ts
const toCamera = new Vector3(cam.x - start.x, 0, cam.z - start.z).normalize()
plane.setFromNormalAndCoplanarPoint(toCamera, startPoint)
```

#### 屏幕空间方向检测
记录第一次点击时的屏幕坐标，后续移动时实时计算 dx/dy 比例：
```ts
isVerticalRef.current = dy > dx * 0.5
```

---

### 4.4 拖拽交互 — `DragHandler.tsx`

**设计思路：** R3F mesh 的 `onPointerMove` 不支持指针捕获，鼠标离开 mesh 后事件停止。
因此改用 canvas DOM 原生 `pointermove`/`pointerup` 事件，该事件不受 3D 对象边界限制。

```ts
useEffect(() => {
  const canvas = gl.domElement
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  return () => { /* cleanup */ }
}, [gl, camera, updateProfile])
```

**拖拽流程：**
1. 用户在导航模式下按下型材 → `Profile.onPointerDown` → `startDrag(id, hitOnGround, originPos)`
2. 每次 `pointermove` → 从屏幕坐标重建 Raycaster → 射线与 Y=0 平面求交 → 计算偏移量
3. 应用网格吸附（5mm）+ 端点吸附（15mm）
4. `pointerup` → `stopDrag()`

**OrbitControls 禁用：** 拖拽期间 `enabled={!isDragging}` 防止相机同步转动。

---

### 4.5 状态管理

#### `useStore`（Zustand + persist）
```ts
interface ProfileData {
  id: string
  spec: ProfileSpec         // '2020' | '2040' | ...
  length: number            // mm
  position: [x, y, z]      // 起点世界坐标
  quaternion: [x, y, z, w] // 旋转（起点→终点方向）
  miterCuts: MiterCut[]    // 预留：斜切信息
  holes: Hole[]             // 预留：打孔信息
}
```

持久化配置：仅 `profiles` 和 `connectors` 保存到 localStorage（key: `aluminum-designer-store`），
`selectedId` 等运行时状态不持久化。

#### `useToolStore`（Zustand，不持久化）
关键状态：

| 字段 | 类型 | 说明 |
|------|------|------|
| `viewMode` | `'draw' \| 'navigate'` | 当前交互模式 |
| `isDrawing` | `boolean` | 是否正在绘制中（已确认起点）|
| `startPoint` | `Vector3 \| null` | 绘制起点 |
| `currentPoint` | `Vector3 \| null` | 当前鼠标位置（含吸附修正）|
| `snapPoint` | `Vector3 \| null` | 当前吸附点（用于黄色指示球）|
| `isDragging` | `boolean` | 是否正在拖拽 |
| `dragProfileId` | `string \| null` | 被拖拽型材 ID |
| `dragStartHit` | `Vector3 \| null` | 拖拽开始时的地面交点 |
| `dragOriginPos` | `Vector3 \| null` | 被拖型材的原始位置 |

---

### 4.6 连接件 — `Connector.tsx`

14 种连接件均由基础几何体（BoxGeometry / CylinderGeometry）组合而成：

| 类型 | 中文名 | 几何描述 |
|------|--------|----------|
| bracket | L型角码 | 两段 20mm 臂，90° |
| inside-corner | 内角码 | 小尺寸内嵌角码 |
| gusset | 加强筋 | 三角形拉伸体 |
| flat-plate | 直连板 | 长条板 + 两个螺孔柱 |
| t-bracket | T型角码 | 横臂 + 垂直臂 |
| cross-bracket | 十字连接板 | 两臂正交十字 |
| corner-3way | 三维角码 | XYZ 三方向 + 中心块 |
| joining-plate | 对接板 | 内置型槽连接条 |
| end-cap | 端盖 | 方板 + 插芯 |
| t-nut | 滑块螺母 | T 形滑块 + 螺柱 |
| hinge | 合页 | 双叶 + 铰轴 |
| pivot | 轴承座 | 底板 + 轴承圈 |
| caster-mount | 脚轮座 | 顶板 + 轮毂 + 轮轴 |
| foot | 调节脚 | 底盘 + 螺柱 + 顶板 |

---

## 5. 交互流程

### 5.1 放置型材（完整流程）

```
用户点击侧边栏型材规格按钮（如 2020）
    ↓
useToolStore.setActiveSpec('2020')
viewMode → 'draw', placementMode → 'profile'
    ↓
DrawingHandler 中的 BackSide 球体激活（viewMode=draw）
    ↓
用户在视口点击起点
    ↓
DrawingHandler.onPointerDown（第一次点击）
  → getWorldPoint(ray, null, false, camera)  // 水平平面
  → useDrawTool.handlePointerDown(worldPoint)
    → findSnapPoint() 寻找附近端点
    → 或 5mm 网格对齐
    → setPoints(point, point), setDrawing(true)
    ↓
用户移动鼠标
    ↓
DrawingHandler.onPointerMove
  → 检测 dx/dy 判断水平/垂直模式
  → getWorldPoint(ray, startPoint, isVertical, camera)
  → useDrawTool.handlePointerMove(worldPoint)
    → findSnapPoint() → setSnapPoint()
    → snapToAxis(start, point) → setPoints(start, axisPoint)
    ↓
视口实时显示：
  - 彩色轴线（X红/Y绿/Z蓝）
  - 半透明型材预览（同色）
  - 黄色吸附指示球
  - Header 显示轴名 + 长度
    ↓
用户点击终点
    ↓
DrawingHandler.onPointerDown（第二次点击）
  → getWorldPoint(ray, startPoint, isVerticalRef.current, camera)
  → useDrawTool.handlePointerDown(worldPoint)
    → snapToAxis() 确保轴对齐
    → dist > 5mm ? 继续 : 忽略
    → 构建 candidate ProfileData（position=起点, quaternion=方向）
    → wouldOverlap(candidate, profiles) ? 丢弃 : addProfile()
    → setDrawing(false), 清除 points/snapPoint
```

### 5.2 拖拽型材

```
（导航模式）用户按下型材
    ↓
Profile.onPointerDown
  → ray.intersectPlane(GROUND_PLANE) → hitOnGround
  → useToolStore.startDrag(id, hitOnGround, position)
  → isDragging=true, OrbitControls.enabled=false
    ↓
用户移动鼠标（canvas DOM pointermove）
    ↓
DragHandler.onPointerMove
  → 重建 Raycaster（屏幕坐标 → NDC → setFromCamera）
  → ray.intersectPlane(GROUND_PLANE) → currentHit
  → delta = currentHit - dragStartHit
  → newPos = dragOriginPos + delta
  → 5mm 网格对齐
  → findSnapPoint() → 15mm 端点吸附
  → updateProfile(id, { position: [x, originY, z] })
    ↓
用户松开鼠标（canvas DOM pointerup）
    ↓
DragHandler.onPointerUp → stopDrag()
isDragging=false, OrbitControls.enabled=true
```

### 5.3 模式切换逻辑

```
默认：viewMode = 'navigate'
  ↓
点击型材规格/连接件 → viewMode = 'draw'
再次点击同一规格/连接件 → viewMode = 'navigate'
Esc 键：
  - 绘制中 → 取消当前绘制（setDrawing false）
  - 非绘制中 → 退出 draw 模式
Delete/Backspace：删除选中对象（仅导航模式）
```

### 5.4 相机操作

| 操作 | 效果 |
|------|------|
| 左键拖拽（导航模式）| 旋转视角 |
| 右键拖拽 / 中键拖拽 | 平移视角 |
| 滚轮 | 缩放 |
| 点击 Home 按钮 | 相机归位 position(300,300,300), target(0,0,0) |
| 绘制/拖拽期间 | OrbitControls 禁用 |

---

## 6. 编译与部署

### 6.1 本地开发

**前提：** Node.js ≥ 20

```bash
# 安装依赖
npm install

# 启动开发服务器（热更新，端口 5173）
npm run dev

# 访问
open http://localhost:5173
```

### 6.2 生产构建（本地）

```bash
# TypeScript 类型检查 + Vite 打包
npm run build

# 产物在 dist/ 目录，可用 nginx 或任意静态服务器托管
npm run preview  # 本地预览生产构建（端口 4173）
```

### 6.3 Docker 构建与部署

**Dockerfile 结构（多阶段构建）：**
```dockerfile
# 阶段1：在 node:20-alpine 中编译
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install          # 依赖层单独缓存
COPY . .
RUN npm run build        # tsc + vite build → dist/

# 阶段2：nginx:alpine 托管静态文件
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
```

**构建镜像：**
```bash
docker build -t aluminum-designer .
```

**运行容器：**
```bash
# 端口映射 4174 → 容器内 80
docker run -d --name aluminum-designer -p 4174:80 aluminum-designer
```

**重新部署（代码更新后）：**
```bash
docker build -t aluminum-designer . \
  && docker rm -f aluminum-designer \
  && docker run -d --name aluminum-designer -p 4174:80 aluminum-designer
```

**查看日志：**
```bash
docker logs aluminum-designer
```

**访问：** http://localhost:4174

### 6.4 .gitignore 说明

```
node_modules/   # npm 依赖，不入库
dist/           # 构建产物，由 CI/Docker 生成
.DS_Store       # macOS 系统文件
*.local         # 本地环境配置
.claude/        # AI 辅助工具配置
```

---

## 7. Bug 记录与修复

### Bug 1：型材不渲染（只有红线，无实体）

**现象：** 绘制时有彩色轴线，点击终点后型材消失，视口中无任何实体。

**根本原因：** `profileShapes.ts` 中规格解析错误。

```ts
// ❌ 旧代码
const matches = spec.match(/\d+/g)
const w = matches ? Number(matches[0]) : 20
const h = matches ? (matches.length > 1 ? Number(matches[1]) : w) : 20
```

`'2020'.match(/\d+/g)` 返回 `['2020']`（整个字符串作为一个数字匹配），
而非预期的 `['20', '20']`，导致 `w=2020, h=2020`（2 米），
型材几何体生成但远超视口范围，肉眼不可见。

**修复：**
```ts
// ✅ 新代码
const w = Number(spec.substring(0, 2))  // '2020' → 20
const h = Number(spec.substring(2)) || w  // '2020'→'' →0→w=20; '2040'→'40'→40
```

**Diff（profileShapes.ts）：**
```diff
-  const matches = spec.match(/\d+/g)
-  const w = matches ? Number(matches[0]) : 20
-  const h = matches ? (matches.length > 1 ? Number(matches[1]) : w) : 20
+  const w = Number(spec.substring(0, 2))
+  const h = Number(spec.substring(2)) || w
```

---

### Bug 2：预览方向正确，放置位置错误（垂直型材水平放置）

**现象：** 鼠标向上移动时绿色预览正确显示垂直型材，但点击后型材被放置在水平方向。

**根本原因：** `DrawingHandler.onPointerDown` 第二次点击（放置）时，
始终用 `isVertical=false`（水平平面），而非跟随鼠标移动时确定的 `isVerticalRef.current`。

```ts
// ❌ 旧代码
const onPointerDown = (e) => {
  if (!toolStore.isDrawing) {
    // 第一次点击
    const pt = getWorldPoint(e.ray, null, false, camera)
    handlePointerDown(pt)
  } else {
    // 第二次点击 — 错误：硬编码 false
    const pt = getWorldPoint(e.ray, toolStore.startPoint, false, camera)
    handlePointerDown(pt)
  }
}
```

**修复：** 第二次点击使用 `isVerticalRef.current`（由 `onPointerMove` 实时更新）。

```diff
-  const pt = getWorldPoint(e.ray, toolStore.startPoint, false, camera)
+  const pt = getWorldPoint(e.ray, toolStore.startPoint, isVerticalRef.current, camera)
```

---

### Bug 3：Z 轴方向无法绘制型材

**现象：** 在任何方向放置了一根型材后，再试图从其端点出发绘制 Z 轴方向型材，
第二次点击无反应（不放置，也不报错）。

**根本原因：** `findSnapPoint` 会把离鼠标点最近的已有端点作为吸附目标，
而 `startPoint` 本身是现有型材的端点，距离为 0（远小于 20mm 阈值），
导致第一次点击吸附到 `startPoint` 自身，`startPoint` 和吸附点重合。
第二次点击时，`findSnapPoint` 仍返回同一个端点，使 dist = 0，被 `dist > 5` 过滤。

**修复：** 为 `findSnapPoint` 增加 `exclude` 参数，排除与 `startPoint` 重合的候选点。

```diff
// snapUtils.ts
 export function findSnapPoint(
   point: THREE.Vector3,
   profiles: ProfileData[],
   threshold = 20,
+  exclude?: THREE.Vector3 | null
 ): THREE.Vector3 | null {
   for (const candidate of [start, end]) {
+    if (exclude && candidate.distanceTo(exclude) < 1) continue
     ...
   }
 }

// useDrawTool.ts
-  const snap = findSnapPoint(worldPoint, profiles, 20)
+  const snap = findSnapPoint(worldPoint, profiles, 20, startPoint)
```

---

### Bug 4：绘制模式下型材 mesh 拦截点击事件

**现象：** 碰撞检测开启后，试图在已有型材附近绘制新型材时，
点击事件被已有型材的 mesh 拦截，导致绘制平面收不到事件。
同时重叠部位渲染异常（变红）。

**根本原因：** R3F 中只要 mesh 有事件处理函数（如 `onClick`），它就会参与射线检测，
并在命中时阻止事件传播到背后的绘制球体。

**修复：** 在绘制模式下（`inDrawMode=true`）禁用型材 mesh 的射线检测。

```diff
// Profile.tsx
+  const inDrawMode = viewMode === 'draw'

   <mesh
+    raycast={inDrawMode ? () => null : undefined}
+    onPointerOver={inDrawMode ? undefined : () => setIsHovered(true)}
+    onPointerDown={inDrawMode ? undefined : onPointerDown}
   >
```

---

### Bug 5：拖拽功能完全失效

**现象：** 在导航模式下点住型材拖拽，型材不移动。

**根本原因：** R3F 事件系统中，mesh 的 `onPointerMove` 只在鼠标**仍在该 mesh 上方**时触发。
鼠标稍微移出 mesh 范围，事件立即停止。
另外 `(e.target as HTMLElement).setPointerCapture(e.pointerId)` 对 Three.js Object3D 无效
（`e.target` 是 THREE.Object3D，不是 HTML 元素，没有 `setPointerCapture` 方法）。

**修复：** 彻底绕开 R3F 事件系统，改用 canvas DOM 原生事件。

```ts
// DragHandler.tsx — 新方案
useEffect(() => {
  const canvas = gl.domElement

  const onPointerMove = (e: PointerEvent) => {
    const { isDragging, ... } = useToolStore.getState()
    if (!isDragging) return
    // 重建 Raycaster 计算世界坐标
    const rect = canvas.getBoundingClientRect()
    const x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    const y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(new THREE.Vector2(x, y), camera)
    // 射线与地面平面求交
    const currentHit = new THREE.Vector3()
    raycaster.ray.intersectPlane(GROUND_PLANE, currentHit)
    // 计算偏移、网格吸附、端点吸附，更新位置
    ...
  }

  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  return () => { canvas.removeEventListener(...) }
}, [gl, camera])
```

**关键区别：** canvas DOM 事件不依赖 Three.js 射线检测，鼠标在任何位置都能触发，
等同于原生 HTML 的指针捕获行为。

---

### Bug 6：React 无限重渲染导致页面崩溃

**现象：** 部署后页面白屏 / JavaScript 崩溃，无法访问。

**根本原因：** `Profile.tsx` 中 `useToolStore` 被调用两次，第二次使用对象选择器：

```ts
// ❌ 旧代码
const { isDragging: isDraggingThis } = useToolStore(s => ({
  isDragging: s.isDragging && s.dragProfileId === id
}))
```

Zustand 的 `useStore(selector)` 使用 `Object.is` 检查引用相等。
selector 每次返回**新对象** `{isDragging: ...}`，导致 Zustand 认为状态永远在变化，
触发无限重渲染，最终栈溢出崩溃。

**修复：** selector 直接返回原始值（boolean），而非对象。

```diff
-  const { isDragging: isDraggingThis } = useToolStore(s => ({
-    isDragging: s.isDragging && s.dragProfileId === id
-  }))
+  const isDraggingThis = useToolStore(s => s.isDragging && s.dragProfileId === id)
```

---

### Bug 7：重叠检测未生效（共轴型材绕过角接头例外）

**现象：** 在同一直线上放置两根相互重叠的同轴型材，系统未阻止，且渲染异常。

**根本原因：** `wouldOverlap` 对非共轴型材设有"角接头例外"（共享端点视为合法），
但代码中共轴型材也误入该分支，被错误地豁免：

```ts
// ❌ 旧代码：共轴型材也可能触发 cornerJoint 豁免
if (!aabbsOverlap(candAABB, exAABB)) continue
const cornerJoint = (/* 端点距离检测 */)
if (cornerJoint) continue  // ← 共轴型材端对端时也会触发此处，造成漏检
return true
```

**修复：** 只有**非共轴**型材才享有角接头例外。

```diff
+  const isCoaxial = (() => {
+    if (!candSeg || !exSeg) return false
+    if (candSeg.axis !== exSeg.axis) return false
+    return Math.abs(candSeg.perp1 - exSeg.perp1) <= PERP_EPS &&
+           Math.abs(candSeg.perp2 - exSeg.perp2) <= PERP_EPS
+  })()

-  const cornerJoint = (/* 端点距离检测 */)
-  if (cornerJoint) continue
+  if (!isCoaxial) {
+    const cornerJoint = (/* 端点距离检测 */)
+    if (cornerJoint) continue
+  }
```

---

## 8. 业界对比分析

### 8.1 主要竞品

| 软件 | 类型 | 特点 |
|------|------|------|
| **MayCad** | Web | 专注铝型材，BOM 导出，连接件库 |
| **Misumi MEXE02** | 桌面 | 精确参数化，与供应商目录直连 |
| **Framing Expert (8020)** | Web | 美国 80/20 配件生态，实时报价 |
| **OpenBuilds Part Designer** | Web | 开源，V-Slot 生态 |
| **SolidWorks / Fusion 360** | 桌面 | 通用 CAD，学习曲线陡峭 |
| **本项目** | Web (Docker) | 轻量浏览器工具，零安装 |

### 8.2 功能对比

| 功能 | 本项目 | MayCad | MEXE02 | Fusion 360 |
|------|--------|--------|--------|------------|
| 浏览器可用 | ✅ | ✅ | ❌ | ✅（有限）|
| 零安装 | ✅ | ✅ | ❌ | ❌ |
| 3D 实时预览 | ✅ | ✅ | ✅ | ✅ |
| 轴对齐强制 | ✅ | ✅ | ✅ | 可选 |
| 端点吸附 | ✅（基础）| ✅ | ✅ | ✅ |
| 角度自由绘制 | ❌ | ❌ | ✅ | ✅ |
| 精确尺寸输入 | ❌（仅属性面板）| ✅ | ✅ | ✅ |
| T 槽截面细节 | ✅ | ✅ | ✅ | ✅ |
| 自动切割计算 | ❌ | ✅ | ✅ | ❌ |
| 连接件数量 | 14 | ~50 | ~100+ | 自定义 |
| 斜切（Miter Cut）| ❌（数据预留）| ✅ | ✅ | ✅ |
| BOM 导出 | ✅（CSV）| ✅（PDF/Excel）| ✅ | ✅ |
| 在线协作 | ❌ | ❌ | ❌ | ✅ |
| 供应商目录集成 | ❌ | 部分 | ✅ | ❌ |
| 撤销/重做 | ❌ | ✅ | ✅ | ✅ |
| 多选操作 | ❌ | ✅ | ✅ | ✅ |
| 尺寸标注 | ❌ | ✅ | ✅ | ✅ |
| 导出 STL/STEP | ❌ | ❌ | ✅ | ✅ |

### 8.3 我们的优势

1. **零依赖安装**：Docker 一键部署，浏览器直接使用
2. **轻量快速**：无需账号，无需加载大型资产库，首屏 <5s
3. **代码完全可控**：可深度定制，与企业内部系统对接
4. **现代技术栈**：React 19 + R3F，便于扩展新功能

### 8.4 我们的劣势

1. **精确输入缺失**：无法直接键入长度数值绘制（只能拖拽估算 + 属性面板修改）
2. **无撤销/重做**：误操作代价大
3. **连接件库不足**：14 种 vs 竞品 50-100+ 种
4. **无自动布局辅助**：复杂框架需要手动规划，无智能对齐辅助线
5. **无尺寸标注**：看不到型材间距、总体尺寸
6. **无斜切支持**：所有接头直角，无 45° 斜接
7. **无导出格式**：无法导出 STL/STEP，与下游 CAD/CAM 断链

---

## 9. 下一步优化方向

按优先级排序（P0 最高）：

### P0 — 核心体验必须修复

#### 精确长度输入
**目标：** 绘制时直接键盘输入长度数值（如 `500 Enter`）确认放置，无需依赖鼠标精度。

**实现思路：**
- 检测 `isDrawing=true` 时的键盘输入，显示输入框 HUD
- 按 Enter 时用输入的长度替代鼠标距离，沿当前吸附轴方向放置

#### 撤销/重做（Ctrl+Z / Ctrl+Y）
**目标：** 操作可逆，消除误操作成本。

**实现思路：**
- Zustand 的 `temporal` 中间件（`zundo`）或自建操作历史栈
- 将 `profiles[]` 和 `connectors[]` 的每次变更推入历史，支持回退

---

### P1 — 显著提升易用性

#### 尺寸标注
**目标：** 实时显示型材长度和端点间距离。

**实现思路：**
- 每根型材中点上方显示长度 `Text` 组件（@react-three/drei `Text`）
- 选中时显示端点坐标
- 可选：悬停时显示邻近型材间距

#### 智能辅助线（Alignment Guides）
**目标：** 拖拽/绘制时，当当前端点与其他型材端点对齐时，显示虚线提示。

**实现思路：**
- 在 pointerMove 时检测当前点与所有端点的轴向对齐关系
- 满足条件时用 `<Line>` 渲染延伸辅助线

#### 多选与群组操作
**目标：** 框选多根型材整体移动/删除。

**实现思路：**
- 导航模式下拖拽空白区域 = 框选（2D 屏幕坐标矩形）
- useStore 中 `selectedId` 改为 `selectedIds: Set<string>`
- 移动时对每个选中对象应用相同的 delta

---

### P2 — 功能完整性

#### 斜切支持（Miter Cut）
数据结构已预留 `miterCuts: MiterCut[]`，需实现：
- UI：选中型材端点，设置斜切角度
- 几何：在 ExtrudeGeometry 上应用斜切变换（沿端面法向量旋转裁剪）

#### 更丰富的连接件库
- 补充：弹性螺母、滑动连接件、铰链支架等
- 考虑接入 MISUMI / 80/20 的开放 API，实时同步真实型材规格和价格

#### BOM 增强
- 按规格汇总（去重 + 数量合计），而非每根单独列出
- 导出 Excel（`.xlsx`）格式
- 附带连接件用量统计

#### JSON 导出/导入
- 将设计导出为 JSON 文件，支持分享和版本管理
- 导入 JSON 恢复设计（比 localStorage 更可靠）

---

### P3 — 长期方向

#### 测量工具
- 点选两个端点 → 显示距离
- 角度测量

#### 截面/投影视图
- 正交投影（俯视图、侧视图、正视图）
- 输出为 SVG 工程图

#### 与供应商集成
- 实时价格计算（对接 MISUMI 铝型材 API）
- 一键生成采购清单

#### 性能优化
- 使用 `InstancedMesh` 批量渲染大量相同规格型材（当前每根独立 mesh）
- 代码分割（Three.js 单包 1.1MB，可按需加载）

#### 协作功能（长期）
- WebSocket 多用户实时协作
- 设计版本历史

---

*文档最后更新：2026-03-18*


---

## 10. v2.0 可施工重构

> 目标：从“能画线的玩具”变成“画完就能下料装出一个柜子”的工具。以下内容以 2026-09-20 的代码为准，第 3～7 章中与之冲突的描述以本章为准。

### 10.1 数据模型不变，几何语义升级

- 数据仍是**中心线模型**：`position` 为起点，沿局部 Z 挤出 `length`。所有吸附、重叠判断都基于中心线。
- **接头自动修剪**（`src/utils/jointUtils.ts`）：渲染和 BOM 使用的是修剪后的真实几何，而不是中心线长度。
  - 贯通优先级 Y（立柱）> X > Z。低优先级构件在接头处**对接**（cut back 半个对方截面），高优先级构件在角接处**延伸**到对方外表面。
  - T 接头：端点落在对方中线内部 → 本构件对接。
  - `computeTrims()` 输出每端 `trim`（正=切短，负=延伸）与 `cutLength`（下料长度）。
  - 例：600×400×800 的 2020 柜体 → 立柱下料 810×4、X 横梁 580、Z 横梁 380、外形 620×420×810，所需角码 = 对接端数。
- **落地规则**：水平构件中心线高度不低于半截面高（2020 → y≥10），从地面起画会自动抬升；立柱从 y=0 起。拖拽、微调、属性编辑都遵守此规则。

### 10.2 绘制：屏幕空间拾取 + 轴向解析（`src/utils/pickUtils.ts`）

- 起点拾取优先级：现有端点（14px 内）→ 现有中线上的点（沿构件按 5mm 网格）→ 地面网格。因此可以从立柱顶端、横梁中点等**任意高度**起画，这是 v1 无法搭出三维柜体的根本原因。
- 轴向判定：比较鼠标位移与 X/Y/Z 三轴**在屏幕上的投影方向**，与相机角度无关；长度 = 射线与该轴直线的最近点，按 5mm 取整。X/Y/Z 键可锁定轴向。
- 终点吸附：轴线上的端点硬吸附（黄点）；不在轴线上的端点只对齐长度并显示紫色对齐线。
- 精确长度：绘制中直接键入数字即聚焦输入框，Enter 下单，跳过吸附与取整。
- 右键取消当前绘制；绘制模式下左键只用于绘制，右键旋转、中键平移。

### 10.3 编辑能力

- 拖拽平面固定在构件**中心线高度**（Shift 为竖直面），两端都参与端点吸附（20mm），pointerup 时用释放点重算一次最终位置（浏览器会按帧合并 pointermove）。
- 多选（Ctrl+点击 / 框选）与成组拖拽；方向键 5mm、Shift 50mm、PgUp/PgDn 竖直微调；Ctrl+D 复制；R 绕 Y 旋转 90°；Delete 删除；F 适配视图。
- 属性面板：规格下拉、中心线长度、起点 XYZ、下料长度与两端接头类型、反向 / 旋转 / 复制按钮。所有编辑都经过重叠与落地校验，失败弹出 toast。
- 所有拒绝都有 toast 反馈（重叠 / 太短 / 陷入地面）；不再使用 `alert`/`confirm`（清空改为两次点击确认）。
- 工程保存 / 打开（JSON，带校验），BOM 按规格+下料长度分组并统计连接件与推荐角码数。

### 10.4 修复的关键缺陷（均已有回归测试）

| 缺陷 | 根因 | 修复 |
|---|---|---|
| 无法从高处起画 | 起点固定取地面平面交点 | 屏幕空间拾取端点/中线 |
| 竖直/水平误判 | 用屏幕 dy>dx·0.5 判断，随相机角度失效 | 三轴屏幕投影匹配 |
| 精确长度被吸附/取整篡改 | 走了普通下单路径 | 独立 `tryAddProfile` 精确路径 |
| 页面整体“假死” | drei `Text` 从 Google CDN 加载字体时 suspend，R3F v9 把 Suspense 冒泡到 DOM 根 | 用 Canvas2D 纹理 Sprite 渲染标注，外加 `<Suspense>` 兜底 |
| 切换模式后型材点不中 | `raycast={undefined}` 在 R3F v9 中把 mesh.raycast 置空 | 不再切换 raycast 属性 |
| 点选后立即被清空 | R3F v9 的 `stopPropagation` 不阻止原生冒泡，`<main>` 的 pointerdown 调用 clearSelection | 型材 pointerdown 中调用 `nativeEvent.stopPropagation()` |
| 拖拽时相机被带偏 | OrbitControls 与 R3F 同时监听 canvas pointerdown，React 置 `enabled=false` 前已开始旋转 | 型材 pointerdown 中同步 `controls.enabled=false` |
| 框选区域整体偏移 320px | `endFrameSelect` 用客户端坐标覆盖了画布相对矩形 | 只由 `<main>` pointerup 设置画布相对矩形 |
| 相机远裁剪面 1000mm | R3F 默认 far | `far: 100000`，适配视图按包围盒计算 |
| 单击型材也产生撤销记录 | pointerdown 即快照 | 首次真正位移时快照 |

### 10.5 真人容错（2026-09-20 第二轮，源自实际试用反馈）

试用反馈：型材重叠、磁吸看不到、起点无法挂到型材端面。根因是第一轮测试用精确坐标驱动，没有模拟“点在型材表面、点偏几毫米”的操作。修正：

- **网格射线拾取**（`DrawingHandler.hitMember` + `pickUtils.modelPointFromHit`）：光标下命中型材实体时，端面 → 该端的中心线端点；侧面 → 沿视线在中心线上取点（距端头 25mm 内吸到端点）。端点吸附不再穿透遮挡：只有属于被命中型材、或比命中点更靠近相机的端点才优先。
- **终点吸附到交叉中线**：绘制轴线穿过另一根型材中心线（距离 <1mm）时长度精确到交点，形成 T 接；其次是光标下型材的中心线投影；再其次对齐远处端点；最后 5mm 网格。HUD 显示吸附类型（端点吸附 / 中线 T 接 / 对齐）。
- **地面起点 X/Z 对齐**：地面点自动对齐已有端点的 X、Z 坐标（12px 内，独立判断）并画出对齐线，随手点的 4 根立柱能落在同一矩形上。
- **容错接头**（`geometryCore.endContactsBody`）：端点落在对方截面范围内（横向 ≤ 对方半截面 +1mm，纵向 ≤ 对方沿本方向半截面 +1mm）即成接头，切到对方表面（`trim = along + extent`，多/少几毫米都被吸收）。重叠放行规则改用同一判定，杜绝“允许放置但不修剪”的穿插。
- **共轴接续**：同轴型材端对端相接时两端都不延伸、不切短（叠层立柱穿过横梁层不会互相穿插）。
- **干涉检查**：`findPenetrations` 对修剪后实体做两两相交检测，BOM 面板实时显示“无干涉 / N 处”。
- **屏幕等大吸附标记**（`SnapMarker`，sizeAttenuation=false）：端点圆点、中线菱形、对齐方块，任意缩放下可见；目标型材高亮为青色。

### 10.6 交互反馈批次（2026-09-20 第三轮，源自 REVIEW.md 评审）

四路评审（视觉 / 交互 / 领域 / 无头实测）后先修的一批，全部属于"工具看起来坏了"类缺陷，不含新功能：

- **拖拽平面取抓取点高度**（`PointerRouter`）：此前平面取 `position[1]`，而立柱的 position 是底端，平面落在地面上，浅视角下抓柱子中部会瞬移到几百毫米外。现在平面过光标抓到的中心线点。
- **选择在转视角后保留**：清空选择从 pointerdown 移到 pointerup，且要求位移小于 5px。拖动空白处是转视角，不再清空。
- **集中式指针路由 + 屏幕空间拾取**（`PointerRouter` + `screenPick.ts`）：导航模式的悬停、选择、拖拽起始统一由一个 canvas 级监听处理，命中判定用"光标到中心线的屏幕距离 ≤ 投影半截面 + 7px"，候选按离相机由近到远解析。修复两个实测问题：远视角点 20mm 细梁脱靶、射线穿透选中背后的立柱。型材与连接件不再各自挂事件。
- **悬停高亮 + 光标状态**：导航模式悬停的型材提亮，光标按状态变化（绘制 crosshair、可拖 grab、拖动中 grabbing、位置非法 not-allowed）。
- **拖拽被拒绝有反馈**：重叠或陷地时 toast（1.5s 节流）+ not-allowed 光标，不再"粘住不动"。
- **精确长度不再静默失败**：小于 10mm 提示"太短"并保留输入；尚未确定方向时提示"先移动鼠标确定方向"。HUD 在整个绘制过程常驻，点完起点立刻敲数字就能用。
- **绘制不会卡死**：在画布外按下（工具栏、侧栏）会取消当前绘制并提示，不再悬置。
- **右键区分单击与拖动**：右键拖动旋转视角不再取消绘制，只有右键单击才取消并提示。
- **Ctrl/⌘+点击只加选**，不再顺带发起拖拽。
- **拖拽端点吸附改为屏幕空间**（14px，上限 40mm），与绘制工具一致，远近视角手感统一。
- 引导文案改为"移动鼠标沿 X / Y / Z 预览，再次单击完成"，修正"拖出"的误导。

未纳入本批、留待后续：连接件子系统（朝向推断、吸附、可拖转、规格参数化）、紧固件推导、BOM 导出增强、字号与对比度基线、多选批量编辑、截面朝向、规格库扩充。

### 10.7 干涉改为告警 + 任意轴旋转（2026-09-21，用户要求）

两条规则性变更，影响面覆盖绘制、拖拽、编辑与渲染：

**1. 允许干涉，红色标出，不再拒绝**
- 放置、拖拽、微调、旋转、改规格/长度/坐标，全部不再因为"会重叠"而被拒绝。原先的 `wouldOverlap` 阻断逻辑与 `snapUtils.ts` 一并删除。
- 干涉检测移到 `analysis.ts`：对**修剪后的实体**做有向包围盒（OBB）分离轴检测（`obb.ts`），返回干涉对、穿透深度与重叠区域。型材可以任意旋转后，AABB 会严重误报，所以必须用 OBB。
- 表现：干涉的型材整根渲染为红色；重叠区域叠加一个红色半透明盒；BOM 面板显示"干涉 N 处"，点击即可选中全部相关型材；新产生干涉时弹一次提示。
- `analyzeFrame(profiles)` 按 profiles 数组引用做记忆化，视口与侧栏共用一次计算。
- 落地规则保留为**钳制**而非拒绝：鼠标拖动与方向键微调不会让构件沉到地面以下；属性面板里手输的坐标是明确意图，不钳制。

**2. 所有零件支持绕 X / Y / Z 任意角度旋转**
- 属性面板新增旋转区：角度输入（任意值，默认 90）+ 六个按钮（X±/Y±/Z±），对当前选择整体生效，支点取选择的几何中心。
- 型材与连接件一视同仁；连接件同时获得位置输入框、可鼠标拖动、参与撤销。
- 快捷键 R 绕 Y 轴 90°，Shift+R 反向。
- 姿态显示按 YXZ 分解（常见的绕垂直轴旋转读数是单个数字，不会出现 -180/60/-180 这种等价但难读的三元组）。
- 下游适配：`getProfileAxis` 对非轴向构件返回 null，接头修剪退化为"无贯通优先级"，仍按端点是否落在对方截面内判定；绘制本身仍保持轴向约束，旋转发生在创建之后。

### 10.8 画布内操作与对齐吸附（2026-09-21，用户要求）

**画布内旋转手柄**（`RotateGizmo.tsx`）
- 选中后在画布上出现三条弧线，拖动即可绕对应轴旋转，5° 步进，支点为选择中心。基于 three 的 TransformControls。
- 三处让位规则，保证不抢模型的点击：① 内置的"自由旋转球"拾取体被移除，只留三条弧；② 光标落在任何零件上时手柄整体停用（`gizmoSuppressed`）；③ 按住 Ctrl/⌘ 时停用。按下瞬间由我们自己对手柄拾取几何做射线检测，不依赖事件顺序。
- 首次真正转动才写入撤销记录；旋转同样不会把零件埋到地面以下（型材与连接件都计入）。工具栏可开关。

**端面拉伸**（`ResizeHandles.tsx` + DragHandler 的 `applyResize`）
- 选中单根型材后两端出现圆饼手柄，按住端面拖动即改变长度，另一端固定；起点端拉伸会同时移动起点。
- 抓取区与手柄直径同源（30mm），短料按 `length/3` 收窄，避免短料无法拖动。不低于最小长度，受落地约束。

**绘制模式下旋转视角**
- 左键在画布上"按下即拖动"= 旋转视角，"按下不移动再松开"= 落点。判定只看位移（5px），不看按住时长，慢点击不会失效。
- 按下时记录射线，触屏点按（没有 pointermove）也能落点；在画布外松开不会落点。

**侧栏可折叠**（`Sidebar.tsx`）
- 整体可收成 40px 图标条；内部「组件库 / 属性编辑 / 物料清单」三个分区各自可折叠，状态存 localStorage。
- 三个分区放在同一个滚动容器里，矮窗口下不会互相挤压；选中零件会自动展开属性区（并持久化）。撤销/重做常驻。

**对齐吸附（重要规则变更）**
- 铝型材框架是贴面装配的，所以拖动时默认吸附：一个轴上的位置会被拉到最近的"面贴合 / 边齐平 / 中线对齐"，阈值为型材宽度（2020 为 20mm，4040 为 40mm）。超过这个距离就自由摆放。实现在 `dragSnap.ts`，作用于整组的包围盒。
- 端点吸附加强（24px，上限 60mm），但只对**非平行**构件生效——平行构件并排时应该贴面，而不是被吸到对方端点上造成重叠。端点接头一旦成立就跳过面对齐，避免二次偏移。
- 吸附参照的构件在拖动中高亮为青色。
- **修饰键调整**：Shift+拖动 = 自由摆放（完全不吸附）；Alt+拖动 = 竖直移动（原 Shift 的职责）。
- 拉伸保留"按下点与端面之间的偏移"，并要求指针真正移动 4px 才开始，端面附近的单击不会误改长度；落地时钳制的是长度而不是整根平移，固定端保持不动。
- 拖拽期间的干涉检测只对被拖部件做增量判断（`movingPartsConflict`），不再每帧全量跑 O(n²)；连接件位置改为每帧一次批量写入。

### 10.9 旋转、端部手柄与吸附的重做（2026-09-21 第三批，依据用户确认的方案）

**旋转改为 90 度定量**（`RotateGizmo.tsx` 重写）
- 删除 three.js 的 TransformControls 圆环。框架是直角结构，自由角度没有意义，圆环还会覆盖模型、抢走点击。
- 改为选中件上方浮动的三个圆箭头按钮（X 红 / Y 绿 / Z 蓝），画在 Canvas 纹理上、屏幕等大。点一次转 90 度，四次回到原位；Shift+点击反向。支点为选择的几何中心。
- 依据：MayCad 的移动/粘贴用 G 键或空格直接转 90 度；Onshape 的操纵器弹角度框并预置 90/270。
- 指针路由通过对按钮做球体射线判定来避让，不依赖事件顺序；`rotateButtons()` 开发钩子供测试定位。

**端部手柄改为端面贴合式**（`ResizeHandles.tsx` 重写）
- 删除两端常驻的实心圆柱。改为：平时端面只有一圈细高亮环；指针靠近该端时浮出半透明锥形箭头；拉伸过程中在旁边显示实时长度。
- 抓取区改为按屏幕像素判定（26px），与画出来的箭头同源，并且不超过构件长度的三分之一。
- 依据：MayCad 的 Stretch 用箭头夹点；Fusion 360 用可拖箭头；Sweet Home 3D 的指示点只在选中件上出现；SketchUp 的缩放夹点贴在包围盒上。

**吸附力度与反馈**
- 阈值从"固定型材宽度"改为"型材宽度与屏幕 18px 对应距离取大值，上限 60mm"。原来 20mm 在常见视距下只有十几像素，能吸但感觉不到。
- 吸附生效时画出青色虚线对齐线，顶部显示吸附类型（贴面 / 齐边 / 中线 / 端点），参照件高亮。只有真正发生拉动的轴才提示，本来就对齐的轴不报。

### 10.10 测试

- 单元测试（vitest，`src/__tests__`，36 个）：接头修剪、容错接触、共轴接续、干涉检查、柜体下料长度、重叠规则、屏幕空间拾取/轴向解析。
- 端到端（Playwright 无头 Chromium + SwiftShader，`e2e/`）：109 个用例覆盖 90 度旋转按钮、端面箭头、吸附反馈、画布内旋转/拉伸/绘制态旋转视角/侧栏折叠/对齐吸附、任意轴旋转与干涉告警、交互反馈批次（拖拽平面、转视角保选、拒绝反馈、拾取容差与遮挡、画布外取消、右键语义、光标状态）、手搓柜子（三种搭法，点击带 ±3px 随机偏移、点在型材表面）、端面/侧面拾取、绘制全部路径、五种规格、选择/框选、拖拽（吸附/阻挡/竖直/成组/撤销）、键盘编辑、属性面板、BOM/CSV/工程文件、清空二次确认、语言切换、持久化、14 种连接件放置与删除、完整柜体搭建。
- 运行：`npm test`（单元）、`npm run test:e2e`（端到端，自动启动 5174 端口 dev server）。
- 测试钩子：开发模式下 `window.__aluframe` 暴露 `store/tool/camera/worldToClient/setView`，用于把世界坐标换成像素点击。
