# Waifu 视觉开发预览

## Qwen 环境背景

运行 `npm run preview:qwen`，打开 [真实 Waifu 页面预览](http://127.0.0.1:4179/)。
预览使用独立的临时样例数据。页面右下角的「Qwen 光照对照」可以固定在原图、织纹、素缎或暗花光位，也可以播放一次完整转光。明暗模式沿用页面自己的切换按钮。

在同一滚动位置切换原图和固定光位，比较亮带有没有沿折面移动，以及织纹和暗花有没有分别显出来。可在 1920×1080、1366×768 和 960×900 的桌面窗口观察弧形包边、立绘和卡片间隙。转光按 12 FPS 更新，重新获得焦点时从停止的位置继续。

左侧复用成就分享卡的 Qwen 原图和离线烘焙的光照图集。右侧使用审核过的深浅两张织物图，以无损 WebP 保存。左右素材各自锚定，在中央内容后方渐隐过渡，右侧织物为静帧。

需要重烘左侧光照时，在装有 FFmpeg 的环境运行 `node public/dev/waifu-visuals/qwen-ambient/art/bake.mjs`。

## Three.js 预览

运行 `npm ci` 和 `npm run visuals:serve`，通过 [Demo 首页](http://127.0.0.1:4178/dev/waifu-visuals-demo.html) 打开预览，也可以直接打开各页。

- [成就徽章](http://127.0.0.1:4178/dev/waifu-visuals/badge/) 保留开发对比，默认抛光倒角和 12 FPS。正式 Waifu 仅在已解锁等级的成就详情显示立体徽章与鼠标倾斜。
- [通知粒子](http://127.0.0.1:4178/dev/waifu-visuals/notice/) 可用固定的 12 FPS 模拟正式通知使用的双弧流光，也可对比开发候选星簇绽放。
- [成就分享卡](http://127.0.0.1:4178/dev/waifu-visuals/achievement-share/) 支持切换成就、中英文、深浅配色和全屏预览。角色背景包括 Qwen「折扇流光」、DeepSeek「洄游潮光」、ChatGPT「鳞间珠光」、Claude「夹页花信」、GLM「靛蓝织谱」、Gemini「风过星帘」、Kimi「折页小夜曲」和 Grok「王女越界」。

先选效果再回放，计数显示回放期间的真实绘制帧，包含开场和结束帧。每个效果有固定轨迹，粒子使用固定随机种子。浏览器实际帧间隔受刷新率和设备负载影响。

修改正式视觉源码后运行 `npm run visuals:build:runtime`，再提交生成的 Waifu 模块和共享 Three.js 文件。Waifu 在显示已解锁徽章或播放新成就通知时按需加载。

`visuals:serve` 调用 `visuals:build` 生成本地 Three.js 文件，再从 127.0.0.1 提供静态资源。该目录用于开发评审，Waifu 和 Lite 的发布入口均不引用它。
