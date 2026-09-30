# 插件入口必须是构建产物 dist/，不能是 src/*.ts

## Problem
0.1.0 以 main: src/index.ts 装进 profile 后，运行时静默不加载（headless 实测报 "agent-swarm: failed to import"）：Node 的类型剥离**拒绝对 node_modules 下的 .ts 生效**。dsh-first-plugin 技能里"绝对路径直挂 .ts"之所以可行，是因为该路径在 node_modules 之外。

## Decision
加 tsconfig.build.json（emit 到 dist/，含 d.ts），package.json main→dist/index.js、types→dist/index.d.ts、files 收 dist、build/prepublishOnly 脚本；版本 0.1.1。

## Alternatives considered
- 保持 TS 直挂、用绝对路径 insert 到 node_modules 外的源目录：本地可用但无法作为包分发，且插件管理页管理不到——否决。
- 手动维护一份 JS 副本：双写漂移源——否决。

## Consequences
安装/分发走标准 npm 包形态；代价是改动后需 rebuild+repack。headless profile 端到端验证通过（工具加载、模型调用、五校验拒绝生效）。

## Confirmation
headless 探针：故意传 1 个 item → 返回 ITEMS_TOO_FEW 原文，证明加载→注册→调用→校验全链路通。
