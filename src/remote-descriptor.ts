/**
 * dsh-agent-swarm — 客户端 Remote 元数据描述符
 *
 * 供 Client 端 $mount 动态注册 Remote 命名空间，纯 JSON 结构，零宿主依赖。
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
        typeSymbol: "dsh-agent-swarm/types#SwarmRosterFrame",
        create: () => passSchema,
      },
    },
  ],
} as const;
