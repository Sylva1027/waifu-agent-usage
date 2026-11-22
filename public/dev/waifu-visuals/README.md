# Waifu Three.js 开发预览

运行 `npm ci` 和 `npm run visuals:serve`，通过 [Demo 首页](http://127.0.0.1:4178/dev/waifu-visuals-demo.html) 打开预览，也可以直接打开各页。

- [成就徽章](http://127.0.0.1:4178/dev/waifu-visuals/badge/) 保留开发对比，默认抛光倒角和 12 FPS。正式 Waifu 仅在已解锁等级的成就详情显示立体徽章与鼠标倾斜。
- [通知粒子](http://127.0.0.1:4178/dev/waifu-visuals/notice/) 可用固定的 12 FPS 反复模拟解锁，对比双弧流光和星簇绽放。

先选效果再回放，计数显示回放期间的真实绘制帧，包含开场和结束帧。每个效果有固定轨迹，粒子使用固定随机种子。浏览器实际帧间隔受刷新率和设备负载影响。

修改立体徽章源码后运行 `npm run visuals:build:badge`，并提交生成的 `public/waifu-achievement-badge.js`。Waifu 通过成就详情按需加载这份文件。

`visuals:serve` 调用 `visuals:build` 生成本地 Three.js 文件，再从 127.0.0.1 提供静态资源。该目录用于开发评审，Waifu 和 Lite 的发布入口均不引用它。
