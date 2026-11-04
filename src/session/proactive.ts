import type { ProactiveConfig } from "../config"

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
