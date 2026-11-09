import type { ProactiveConfig } from "../config"
import type { ChatOverride } from "../overrides"

/**
 * 把“每小时目标概率”换算成单次心跳的触发概率。
 *
 * 直接在每个 tick 上抽 `startProbability + probabilityPerHour * hours` 会让实际频率
 * 随 tickSeconds 放大；这里按 tick 占一小时的比例做指数换算。
 */
export function proactiveTickProbability(
  config: Pick<
    ProactiveConfig,
    "startProbability" | "probabilityPerHour" | "silenceThresholdSeconds" | "tickSeconds"
  >,
  silenceSeconds: number,
): number {
  const silenceHours = (silenceSeconds - config.silenceThresholdSeconds) / 3600
  if (silenceHours <= 0) return 0
  const target = Math.min(1, config.startProbability + config.probabilityPerHour * silenceHours)
  if (target >= 1) return 1
  const fraction = Math.min(1, config.tickSeconds / 3600)
  return 1 - Math.pow(1 - target, fraction)
}

/**
 * 这个聊天这一轮主动说话的概率。
 *
 * 聊天自己写了概率就用它：那是单次心跳的触发概率，不再随沉默时长增长。
 * 沉默阈值对所有聊天一视同仁，没到阈值就不主动开口。
 */
export function proactiveProbability(
  override: ChatOverride,
  config: Pick<
    ProactiveConfig,
    "startProbability" | "probabilityPerHour" | "silenceThresholdSeconds" | "tickSeconds"
  >,
  silenceSeconds: number,
): number {
  const silenceHours = (silenceSeconds - config.silenceThresholdSeconds) / 3600
  if (silenceHours <= 0) return 0
  if (override.proactiveProbability !== undefined) return override.proactiveProbability
  return proactiveTickProbability(config, silenceSeconds)
}
