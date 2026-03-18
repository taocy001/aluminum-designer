# Aluminum Designer — 设计文档

---

## 目录

1. [项目概述](#1-项目概述)
2. [技术栈](#2-技术栈)
3. [架构设计](#3-架构设计)
4. [核心模块详解](#4-核心模块详解)
5. [交互流程](#5-交互流程)
6. [编译与部署](#6-编译与部署)

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
```
