import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 调度器测试用 fake timers 推进大量虚拟时间（含 180s 容量恢复、128 成员放量），
    // 单测真实耗时高于 vitest 默认的 5s，这里放宽到 20s。
    testTimeout: 20_000,
  },
});
