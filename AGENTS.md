# dsh-agent-swarm 工作规矩

## Quick Commands

```sh
pnpm install        # 装依赖
pnpm test           # vitest 全部测试
pnpm typecheck      # tsc --noEmit
pnpm run build      # 编译到 dist/（发布/安装必须，见下）
```

## 红线

- **clean-room**：实现代码与文档只允许引用 `../extracted/kimi-code-swarm-analysis/01-机制文档/`、`03-v1源码/`（MIT）、`04-协议层/v1-protocol-swarm-slices.mjs`（MIT）。**禁止打开** `02-v2源码/` 与 `05-UI与API层/`；工具描述/提示词文本一律重写，不复制 Kimi 原文。
- 参考了 v1 MIT 代码的模块，在文件头注释标注来源并在 THIRD-PARTY-NOTICES.md 登记。
- 插件只用命名导出（`export const name/inject` + `export function apply`），**绝不写 `export default`**。
- 所有 `ctx` 副作用（监听器、定时器、注册）必须可逆，卸载时清理。
- 不要在 `disabled`/`isolate`/`intercept` 元数据上写 `!!js` 表达式（Cordis 只对 config 插值）。
- **入口必须指向构建产物**：Node 拒绝对 node_modules 下的 .ts 做类型剥离（实测报错 "Stripping types is currently unsupported for files under node_modules"），所以 main 必须是 dist/index.js；改完代码要重新 pnpm run build + npm pack 再装。
