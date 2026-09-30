# Cordis 真实 Loader 测试与 apply 键语义

## Problem
dsh 官方复盘教训：手动挂载插件的测试全绿也抓不住 Loader 层问题（default export 陷阱就是这么漏的）。本插件必须有走真实 Loader 路径的测试。

## Decision
tests/plugin.test.ts 用 @deepseek-ai/cordis + cordis-plugin-loader 真实创建 Context/Loader/entry，只替换模块装载一步（loader.internal.import，因原生 Node 不能 import .ts——这正是 DSH 预留的 seam），解包/注册/激活/卸载全部走 Loader 真实实现。同进程多例测试时用薄转发 `apply: (ctx,cfg) => plugin.apply(ctx,cfg)` 包装，规避 Cordis 注册表以 apply 函数引用为键的语义（同引用重复注册会并入既有 runtime、dispose 链失效；真实运行每次全新 import 不受影响）。

## Alternatives considered
- 退化为 node import 断言导出形态：抓不到 unwrapExports/registry 层问题——仅作后备，未采用。
- 先构建成 JS 再测：引入构建步骤，与"TS 直挂"开发流不符——否决。

## Consequences
测试能抓住 default export、inject 缺失、注册不可逆这三类 Loader 层事故；代价是测试内部要了解 loader.internal seam。

## Confirmation
测试断言：加载后工具在注册表、loader.remove 后注册表为空、无 default export。
