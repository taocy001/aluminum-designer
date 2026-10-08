# 图片与操作演示

文档配图取自当前应用。家具与连接件使用仓库 JSON；首页动图从空白工程开始，通过界面搭建五层置物架。

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

```bash
node scripts/record-demo.mjs
```

录制使用独立浏览器会话，依次操作模板尺寸、Shift 多选、嵌入板件、板材固定、复制粘贴、撤销、内角码自动安装、视角及保存。鼠标显示蓝色圆点，按下时变为橙色；输入逐字符完成，操作间保留停顿。

开发钩子只用于读取结果和将世界坐标换算为点击位置，不写入工程零件。录制在无原生文件选择 API 的模式下演示下载副本，再从文件菜单打开下载的 JSON。该模式不能代表覆盖原文件的操作。

输出位于已忽略的 `test-results/demo-recording/`：原始 WebM、保存的工程、编辑界面和保存窗口截图。核对结果后将两张截图复制到 `docs/`，将录像转换为 `docs/demo.gif`。动图可缩短无变化的等待帧；模型编辑、鼠标轨迹和输入顺序保持不变。

两种脚本都支持 `EXAMPLES_BASE_URL` 指向其他开发服务地址。Linux 缺少浏览器依赖时可运行 `npx playwright install --with-deps chromium`。

## 图纸与提交范围

`public/hardware/ap-4040b6-m8.svg` 是按程序参数绘制的加工尺寸图，包含底视图、单孔剖面及装配说明。更新时需同步核对 [配件规格](CONNECTOR-ACCESSORIES.md)、`connectorHardware.ts` 的尺寸和示例中的装配位置；不应根据截图推算加工尺寸。

提交最终使用的 PNG、GIF、SVG 和可复用脚本。原始录像、抽帧图片、失败截图、录制工程和检查日志留在忽略目录或系统临时目录，发布后删除本次产生的临时文件。
