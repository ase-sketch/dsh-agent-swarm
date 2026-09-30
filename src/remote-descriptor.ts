/**
 * dsh-agent-swarm — 客户端 Remote 元数据描述符
 *
 * 供 Client 端 $mount 动态注册 Remote 命名空间，纯 JSON 结构，零宿主依赖。
 *
 * ── 关于 result 的 typeSymbol 与强类型 codec ──
 *
 * swarm/roster 是 stream 方法，descriptor 的 result codec 描述的是**流中每一项**的
 * 类型，而流里跑的每一项是 {@link SwarmFrame} 联合体（opened / roster / closed），
 * 不是单一的 SwarmRosterFrame。故 result 的 typeSymbol 指向联合类型
 * `dsh-agent-swarm/types#SwarmFrame`——与 SwarmRemote.roster 实际的
 * `AsyncIterable<SwarmFrame>` 产出严格一致。
 *
 * 强类型 codec 启用时的语义（当前 create() 仍返回 passSchema 透传，故今天行为不变）：
 *   - 联合类型按 `type` 判别式（discriminator）校验：每一项都必须落在
 *     opened / roster / closed 三个分支之一，缺 `type` 或 `type` 非法即拒绝。
 *   - 只有 roster 分支带 members / 各类计数；opened 携带 description/total，
 *     closed 仅携带 swarmId/sessionId/at。强类型 codec 必须允许这三者字段集不同，
 *     不能按 SwarmRosterFrame 统一校验（那会让 opened/closed 因缺 members 而被拒）。
 *   - 客户端按 frame.type 收窄后即可拿到各分支的精确类型，无需再断言。
 *
 * 之所以必须与产出一致：声明若停在 SwarmRosterFrame，今天靠 passSchema 透传不崩，
 * 但一旦宿主换用真正按 typeSymbol 生成/校验的强类型 codec，opened/closed 两类帧就会
 * 因"不是 roster"而被判失败。
 */

const passSchema = {
  parse: (val: unknown) => val,
};

export const TYPERT_REMOTE = {
  package: "dsh-agent-swarm",
  descriptors: [
    {
      id: "dsh-agent-swarm#swarm/roster",
      service: "swarmRemote",
      namespace: "swarm",
      method: "roster",
      mode: "stream",
      invocation: { kind: "direct" },
      parameters: [
        {
          name: "request",
          wire: "request",
          source: "json",
          codec: {
            mode: "strict",
            typeSymbol: "dsh-agent-swarm/types#SwarmRosterRequest",
            create: () => passSchema,
          },
        },
      ],
      cancellation: { parameter: "signal" },
      result: {
        mode: "strict",
        // 每一项都是 SwarmFrame 联合体（opened/roster/closed），不是单一 roster 帧。
        // 详见文件头「关于 result 的 typeSymbol 与强类型 codec」段。
        typeSymbol: "dsh-agent-swarm/types#SwarmFrame",
        create: () => passSchema,
      },
    },
  ],
} as const;
