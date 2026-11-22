# Waifu Three.js 开发预览

运行 `npm ci` 和 `npm run visuals:serve`，通过 [Demo 首页](http://127.0.0.1:4178/dev/waifu-visuals-demo.html) 打开三项预览，也可以直接打开各页。

- [成就徽章](http://127.0.0.1:4178/dev/waifu-visuals/badge/) 使用现有 WebP，比较抛光与双槽倒角。
- [通知粒子](http://127.0.0.1:4178/dev/waifu-visuals/notice/) 可反复模拟解锁，比较细点与短光线。
- [角色空间背景](http://127.0.0.1:4178/dev/waifu-visuals/skin/) 可切换十款立绘、深浅主题、透明度、细光环与稀疏轨道。

每页支持 12、15、30 FPS。先选效果再回放，计数显示回放期间的真实绘制帧，包含开场和结束帧。每个效果有固定轨迹，粒子使用固定随机种子。浏览器实际帧间隔受刷新率和设备负载影响。

`visuals:serve` 调用 `visuals:build` 生成本地 Three.js 文件，再从 127.0.0.1 提供静态资源。该目录用于开发评审，Waifu 和 Lite 的发布入口均不引用它。
