# 打包形态升级为 bundle（插件管理页可见）

## Problem

裸 cordis 插件经 profile 依赖 + `cordis.patch.yml` insert 挂载后，只出现在只读的「内置插件 inventory」页；侧边栏「插件」管理页（`dsh-plugin-manager`）管的是 bundle 及其行，裸插件不可见、不可启停、不可卸载。用户明确要求管理页可管理。

## Decision

M4b 把 dsh-agent-swarm 改造为 bundle 形态：`package.json` 声明 `dsh.bundle.patch: "./cordis.patch.yml"`，包内自带该文件，唯一的 insert 行 `name` 自指本包（`dsh-agent-swarm`）。`dsh plugin add` 读到这个声明才会把包名 reconcile 进 `dsh.profile.bundles`（`@deepseek-ai/dsh-plugin-manager/lib/index.js:237-263`），管理页随之可见。

关键实测（0.2.0-rc.2）：

- **单包双身份**可行。官方 bundle 的 `main` 指向 11 字节空壳，但 loader 从 `cordis.patch.yml` 行的 `name` 解析包入口，`main` 不参与挂载；本包保持 `main: dist/index.js`（AGENTS.md:19 红线）同时当 bundle 外壳与真插件，无需拆两个包。
- **行内 `name` 用 npm 包名**，不是相对路径（对照 `@deepseek-ai/dsh-experimental-schedule-bundle/cordis.patch.yml:12-22`）。
- **层序**：bundle 层先、profile 的 `cordis.patch.yml` 后（`web/cordis.yml:1-4` 头注释）。迁移后 profile 里若还留同 id 的 insert 行会**重复挂载**（同 `web/cordis.patch.yml:269-271` 对 codex-ui 的既有警告），故 web/desktop/headless 三处的旧 insert 行已拆除；用户层仍可按 id `agent-swarm` 改 config 或 disable，但不能重插。
- **不加 peerDependencies**：`evaluatePluginCompatibility`（`dsh-app-boot/lib/index.js:286-313`）只校验 `@deepseek-ai/dsh*` 形式的 peer；`loadProfileDirectory:930-931` 在 peer 不兼容时**整层跳过**且只进 `skippedBundles`。反例：`dsh-ui-ux-pro-max` 因 peer 写 `"<0.2.0-0"` 被 0.2.0-rc.2 门禁拒载。本包无 peer，运行时 `@deepseek-ai/*` 由 harness 解析。

## Alternatives considered

- 裸插件直接进 `dsh.profile.bundles`：2026-09-17 实测会让 boot 崩（bundles 只收声明了 `dsh.bundle` 的包）——否决。
- 保持 patch insert 不改：管理页不可见，不满足用户要求——否决。
- 拆成「bundle 外壳包 + 独立插件包」双包：官方外壳包 `main` 是空壳，拆开要多维护一个包与一条内部依赖，且本包自指已验证可行——否决（无收益的复杂度）。
- 加 `peerDependencies: {"@deepseek-ai/cordis": "~4.0.4"}` 跟随官方：cordis 不在兼容门禁射程（只有 `@deepseek-ai/dsh*` 被校验），但会给未来加 dsh peer 埋静默跳过的坑——否决。
- 加 `icon.svg`：官方每个 bundle 都有，管理页显示图标；保留一个原创几何图形（中心节点 + 四卫星）。

## Consequences

收益：用户可自助启停/卸载，分发形态与官方插件一致。代价：包结构多一层 bundle 声明；web/desktop/headless 三 profile 的旧 patch insert 行已拆除，**回滚须同时还原 `cordis.patch.yml.bak-bundle` 并把 bundles 数组里 `dsh-agent-swarm` 摘掉**，只还原其一会重复挂载。

## Confirmation

- `dsh --profile web --dump-config`：exit 0，无 error、无 skipping profile bundle；`agent-swarm` 行恰好 1 次，位于 `# == dsh-agent-swarm` bundle 层头之下、用户 patch 层之上（2026-10 验收实测）。
- `dsh --profile headless`：`"只回复两个字：收到"` 无 failed to import；探针传 1 个 item 返回 `A swarm needs at least 2 items, got 1.`（`src/validate.ts:70` 原文），证明工具真活着。
- 管理页条目可见性由用户在两端重启后目测确认（Electron 独占 profile，代理不能代重启）。
