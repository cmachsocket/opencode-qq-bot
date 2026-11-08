import type { AccessConfig } from "../src/access"

/**
 * 构造准入配置。
 *
 * 测试里绝大多数场景只想放行一两个目标，用它省去重复写完整结构；
 * 需要拒绝名单或空名单兜底时再通过 `overrides` 覆盖。
 */
export function accessConfig(
  allow: { groups?: number[]; users?: number[] },
  overrides: Partial<AccessConfig> = {},
): AccessConfig {
  return {
    allow: { groups: allow.groups ?? [], users: allow.users ?? [] },
    deny: { groups: [], users: [] },
    allowAllWhenEmpty: false,
    ...overrides,
  }
}
