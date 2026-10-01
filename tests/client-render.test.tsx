// @vitest-environment jsdom
/**
 * SwarmHeaderAction 渲染测试（jsdom + @testing-library/react）。
 *
 * 此前该组件（700+ 行）零渲染覆盖，任何 UI 改动只能靠"重启 DSH 后目测"验收。
 * 这里覆盖：徽标聚合、弹层分组折叠、多批次切换、流失败提示、限流倒计时、i18n（框架注入的 t）。
 */

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SwarmHeaderAction } from "../src/client/SwarmHeaderAction.js";
import { ClientSwarmModel } from "../src/client/model.js";
import { en, translatorFor, zh } from "../src/client/locales.js";
import type { SwarmMemberView, SwarmRosterFrame } from "../src/swarm-registry.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function member(index: number, over: Partial<SwarmMemberView> = {}): SwarmMemberView {
  return { index, item: `item-${String(index)}`, phase: "pending", retryCount: 0, ...over };
}

function frame(swarmId: string, members: SwarmMemberView[], over: Partial<SwarmRosterFrame> = {}): SwarmRosterFrame {
  const count = (phases: string[]) => members.filter((m) => phases.includes(m.phase)).length;
  return {
    type: "roster",
    swarmId,
    sessionId: "s1",
    description: `batch ${swarmId}`,
    total: members.length,
    activeCount: count(["starting", "running", "retrying"]),
    completedCount: count(["completed"]),
    failedCount: count(["failed"]),
    abortedCount: count(["aborted"]),
    members,
    at: 1,
    ...over,
  };
}

function mount(options: { t?: ReturnType<typeof translatorFor> } = {}) {
  const model = new ClientSwarmModel();
  const watchSwarm = vi.fn(() => () => undefined);
  const utils = render(
    <SwarmHeaderAction sessionId="s1" useSwarm={model.useSwarm} watchSwarm={watchSwarm} {...options} />,
  );
  const push = (f: SwarmRosterFrame) => {
    act(() => {
      model.rosterReceived(f);
    });
  };
  const open = () => {
    fireEvent.click(screen.getByRole("button", { name: /Swarm/ }));
  };
  return { ...utils, model, watchSwarm, push, open };
}

describe("SwarmHeaderAction 渲染", () => {
  it("挂载即按会话订阅流；无批次时徽标为 0、弹层显示空态", () => {
    const view = mount();
    expect(view.watchSwarm).toHaveBeenCalledWith("s1");
    expect(view.container.querySelector(".dsh-swarm-badge")?.textContent).toBe("0");
    view.open();
    expect(screen.getByText(zh.empty)).toBeTruthy();
  });

  it("成员按相位分组：进行中/失败默认展开，已完成默认收起，可单独折叠", () => {
    const view = mount();
    view.push(
      frame("a", [
        member(1, { phase: "running" }),
        member(2, { phase: "failed", detail: "boom" }),
        member(3, { phase: "completed" }),
      ]),
    );
    expect(view.container.querySelector(".dsh-swarm-badge")?.textContent).toBe("1/3");
    view.open();
    expect(screen.getByText("item-1")).toBeTruthy();
    expect(screen.getByText("item-2")).toBeTruthy();
    expect(screen.getByText("boom")).toBeTruthy();
    expect(screen.queryByText("item-3")).toBeNull(); // 已完成组默认收起

    fireEvent.click(screen.getByText("已完成 1 个成员"));
    expect(screen.getByText("item-3")).toBeTruthy();
    fireEvent.click(screen.getByText("进行中 1 个成员"));
    expect(screen.queryByText("item-1")).toBeNull();
  });

  it("同一会话并发的多个批次：出现切换标签，徽标聚合全部可见批次", () => {
    const view = mount();
    const first = frame("a", [member(1, { phase: "running" }), member(2, { phase: "running" })], {
      visibleSwarmIds: ["a"],
    });
    const second = frame("b", [member(1, { phase: "completed" })], { visibleSwarmIds: ["a", "b"] });
    view.push(first);
    view.push(second);
    expect(view.container.querySelector(".dsh-swarm-badge")?.textContent).toBe("2/3");

    view.open();
    const tabs = within(screen.getByRole("tablist")).getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    // 默认选中最新批次
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getAllByText("batch b").length).toBeGreaterThan(0);

    fireEvent.click(tabs[0] as HTMLElement);
    expect(within(screen.getByRole("tablist")).getAllByRole("tab")[0]?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("item-1")).toBeTruthy();
  });

  it("流异常终止：触发按钮与弹层都显示可见的错误（不静默）", () => {
    const view = mount();
    act(() => {
      view.model.streamFailed("s1", "socket hang up");
    });
    const trigger = screen.getByRole("button", { name: /Swarm/ });
    expect(trigger.getAttribute("title")).toBe("流连接中断：socket hang up");
    view.open();
    expect(screen.getAllByText("流连接中断：socket hang up").length).toBeGreaterThan(0);
  });

  it("限流退避成员显示重试次数与倒计时，并随 1 秒节拍递减", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const view = mount();
    view.push(frame("a", [member(1, { phase: "retrying", retryCount: 2, retryReadyAt: 13_000 })]));
    view.open();
    const detail = () => view.container.querySelector(".dsh-swarm-detail")?.textContent;
    expect(detail()).toBe("第 2 次限流重试 · 约 3 秒后发起");
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(detail()).toBe("第 2 次限流重试 · 约 2 秒后发起");
  });

  it("被截断的长 item：悬浮提示注明原文长度", () => {
    const view = mount();
    view.push(frame("a", [member(1, { item: "xxxx…", itemChars: 5000 })]));
    view.open();
    expect(screen.getByText("xxxx…").getAttribute("title")).toBe("xxxx…（原文 5000 字符）");
  });

  it("i18n：使用框架注入的 t（英文字典）时界面不残留任何中文", () => {
    const view = mount({ t: translatorFor(en) });
    view.push(
      frame("a", [
        member(1, { phase: "running" }),
        member(2, { phase: "retrying", retryCount: 1, retryReadyAt: Date.now() + 5_000 }),
        member(3, { phase: "failed", detail: "boom" }),
      ]),
    );
    view.open();
    const text = view.container.textContent ?? "";
    expect(text).toContain("Swarm Agent Queue");
    expect(text).toContain("Rate-limit retry #1");
    expect(text).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
