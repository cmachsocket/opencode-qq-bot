import type { QQBotConfig } from "./config"
import { collectEnvSecrets, secretsFromUrl } from "./sensitive"

/**
 * 已知凭证明文：日志逐行打码与出站拦截都靠它。
 *
 * 除了环境变量与 NapCat 令牌，地址查询串里挂着的 token 也要算进来，
 * 否则它会原样落进日志文件。面板令牌同样算进来：它能进日志文件就等于面板失守。
 *
 * 单独成模块是为了让面板也能用：面板不需要把整个插件入口拉进来。
 */
export function knownSecrets(config: QQBotConfig): string[] {
  return [
    ...collectEnvSecrets(process.env),
    config.napcat.token ?? "",
    // 面板令牌能进日志文件就等于面板失守，日志里一律掩码。
    config.panel.token ?? "",
    ...secretsFromUrl(config.napcat.url),
  ].filter((secret) => secret.length > 0)
}
