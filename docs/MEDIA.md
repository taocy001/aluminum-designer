# 图片与操作演示

文档配图取自当前应用。家具与连接件使用仓库 JSON；完整视频从空白工程开始，通过界面搭建五层置物架，首页动图截取环绕和缩放片段。

## 生成静态预览

```bash
npm ci
npx playwright install chromium
npx vite --port 5174 --strictPort
```

保持服务运行，另开终端：

```bash
node scripts/capture-examples.mjs
```

脚本通过文件菜单导入工程，生成六张家具截图及对应 BOM CSV、十四种连接件的局部图集、十二柜总览。局部图集只调整相机，保留模型检查的显示结果。生成完成后统一写入 `examples/`；临时目录在结束时删除。只更新单例可运行 `node scripts/capture-examples.mjs bookcase-tall`。

## 录制建模操作

录制使用正式构建；测试钩子仅供脚本读取模型和投影点击位置。另开服务端口：

```bash
VITE_TEST_HOOK=1 npx vite build --outDir /tmp/aluframe-record-build
npx vite preview --outDir /tmp/aluframe-record-build --port 5175 --strictPort
```

```bash
EXAMPLES_BASE_URL=http://127.0.0.1:5175 node scripts/record-demo.mjs
```

录制使用独立浏览器会话，依次操作模板尺寸、Shift 多选、嵌入齐平隔板、板材固定、复制粘贴、撤销、内角码自动安装、整组拖拽、输入 15° 绕 Y 轴旋转、视角环绕、滚轮缩放、右键平移及保存。鼠标显示蓝色圆点，按下时变为橙色；输入逐字符完成，操作间保留停顿。脚本检查隔板顶面、固定件、干涉及拖拽和旋转后的模型变化。

录制要求硬件 WebGL，遇到软件渲染器即停止。`RECORD_GL_BACKEND` 可选择 Chromium 的 ANGLE 后端。使用 WSL Mesa D3D12 时，可设置 `MESA_LOADER_DRIVER_OVERRIDE=d3d12 GALLIUM_DRIVER=d3d12 RECORD_GL_BACKEND=gl-egl`，并确保 WSL 图形库可加载；脚本会打印实际渲染器，须确认使用 GPU。

开发钩子只用于读取结果和将世界坐标换算为点击位置，不写入工程零件。录制在无原生文件选择 API 的模式下演示下载副本，再从文件菜单打开下载的 JSON。该模式不能代表覆盖原文件的操作。

输出位于已忽略的 `test-results/demo-recording/`：原始 WebM、操作时间点、保存的工程、编辑界面和保存窗口截图。成功完成后写入校验文件，编码前核对各文件属于同一次完整录制；中断或失败的录像不能发布。核对结果后安装 FFmpeg 并运行：

```bash
node scripts/encode-demo.mjs
```

可用 `FFMPEG` 指定可执行文件。脚本保留原始 WebM 的时间顺序与停顿，原速转码为 `docs/demo.mp4`；另生成 20 fps 的 `docs/demo.gif` 预览，并复制两张截图到 `docs/`。Playwright 录像为 25 fps，不等于应用的渲染帧率。MP4 不按画面变化大小删帧；动图的操作时间点按首条字幕出现的实际帧对齐。发布前检查拖拽、环绕和缩放片段的实际播放，不能只检查静态截图。

两个浏览器脚本都支持 `EXAMPLES_BASE_URL` 指向其他本地服务地址。Linux 缺少浏览器依赖时可运行 `npx playwright install --with-deps chromium`。

## 交互性能测量

使用上述带测试钩子的构建与独立端口，关闭其他测试和录制进程后执行：

```bash
node scripts/benchmark-interaction.mjs http://127.0.0.1:5175 /tmp/aluframe-benchmark.json
```

`BENCH_GL_BACKEND` 与录制脚本的 ANGLE 后端选项作用相同。脚本打印实际渲染器，在 1400×900 视口中分别拖动 150、500 根独立 2020 型材的完整选择集，关闭尺寸与编号标签，检查模型确实移动，并记录渲染间隔和 CPU 采样。采样区间从按下鼠标后开始，到最后一次移动完成结束；包含 30 次目标间隔 25 ms 的移动，浏览器繁忙时实际间隔会延长。

2026-10-09，WSL Mesa D3D12、GTX 1070 Ti 的单次测量如下：

| 型材数量 | 平均渲染帧率 | 渲染间隔中位数 | 渲染间隔第 95 百分位 |
|---|---:|---:|---:|
| 150 | 54.9 fps | 12.3 ms | 42.7 ms |
| 500 | 43.7 fps | 16.6 ms | 61.4 ms |

这些数值包含 CPU 采样开销，统计场景渲染次数，并非每秒几何更新次数或录像编码帧率。它们只代表该夹具和设备，不能代替密集接头、门抽或完整柜子的操作测试。

## 图纸与提交范围

`public/hardware/ap-4040b6-m8.svg` 是按程序参数绘制的加工尺寸图，包含底视图、单孔剖面及装配说明。更新时需同步核对 [配件规格](CONNECTOR-ACCESSORIES.md)、`connectorHardware.ts` 的尺寸和示例中的装配位置；不应根据截图推算加工尺寸。

提交最终使用的 PNG、GIF、MP4、SVG 和可复用脚本。原始录像、抽帧图片、失败截图、录制工程和检查日志留在忽略目录或系统临时目录，发布后删除本次产生的临时文件。
