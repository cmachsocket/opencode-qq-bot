import { DETECTORS, redact, scan, type Detector } from "flare-redact"

/** 命中的敏感信息。 */
export interface SensitiveHit {
  /** 检测器 id，例如 github_token。 */
  detector: string
  /** 检测器给出的原因，不含原文。 */
  why: string
}

/** 出站检查的结果。 */
export interface SensitiveVerdict {
  /** 是否可以发出去。 */
  allowed: boolean
  /** 命中的检测器，已去重。 */
  hits: SensitiveHit[]
  /** 回给模型的说明；放行时为空串。 */
  reason: string
}

const CLEAN: SensitiveVerdict = { allowed: true, hits: [], reason: "" }

/**
 * 隐私类检测器：邮箱、卡号、IBAN 在群聊里是正常内容，不拦。
 *
 * 出站拦截只针对凭证——把群里的「我的邮箱是 a@b.com」拦下来只会让人不敢用。
 */
const PII_DETECTORS = new Set(["email", "obfuscated_email", "credit_card", "iban"])

/**
 * 默认关闭、但确实算凭证的检测器。
 *
 * `internal_url` 会命中 localhost 与内网地址：本插件的威胁模型里，
 * 内网地址泄漏到日志或出站消息同样算问题，所以显式打开。
 */
const EXTRA_SECRET_DETECTORS = new Set(["seed_phrase", "internal_url"])

/**
 * 出站要跑的检测器。
 *
 * 取 flare-redact 的默认检测器，去掉隐私类，再补上默认关闭的凭证类。
 * 高熵串（UUID、哈希、base64 片段）会误伤，不开。
 */
export const SECRET_DETECTORS = DETECTORS.filter(
  (d) =>
    !PII_DETECTORS.has(d.id) &&
    d.id !== "high_entropy" &&
    (d.default || d.tags?.includes("secret") || EXTRA_SECRET_DETECTORS.has(d.id)),
).map((d) => d.id)

/** 环境变量名里出现这些词，值就按凭证看。 */
const SECRET_NAME =
  /(?:^|_)(?:API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|SECRET_?KEY|CLIENT_?SECRET|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH)(?:_|$)/i

/** 凭证至少这么长，太短的容易撞车。 */
const MIN_SECRET_LENGTH = 12

/** 已知凭证的分片长度：够长不撞车，又短到能抓住被拆开的凭证。 */
const FRAGMENT_LENGTH = 12

/** 零宽字符：插在凭证中间用来骗过正则。 */
const ZERO_WIDTH = /[\u200B-\u200F\u2060\uFEFF]/g

/** 文本里像 base64 的片段。 */
const BASE64_RUN = /[A-Za-z0-9+/_-]{20,}={0,2}/g

/** 最多解多少段 base64，防止有人拿大段数据硬撑。 */
const MAX_BASE64_RUNS = 32

/** 指向凭证文件的路径片段。 */
const SENSITIVE_PATH_PARTS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".npmrc",
  ".netrc",
  ".git-credentials",
  ".env",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
  ".pem",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".pgpass",
  ".my.cnf",
  ".htpasswd",
  "credentials.db",
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** 归一化：全角转半角、去掉零宽字符，让「ｐａｓｓｗｏｒｄ＝」这类写法也能命中。 */
function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(ZERO_WIDTH, "")
}

/**
 * 判断一个环境变量的值像不像凭证。
 *
 * 名字已经筛过一轮，这里只排掉明显不是凭证的形态：太短、带空格、
 * 是路径、是 URL、是 JSON。剩下的长字符串都当凭证看。
 */
function looksLikeSecret(value: string): boolean {
  if (value.length < MIN_SECRET_LENGTH) return false
  if (/\s/.test(value)) return false
  if (/^[/~]/.test(value) || /^\.\.?[/]/.test(value) || /^[A-Za-z]:[/\\]/.test(value)) return false
  if (/^https?:\/\//i.test(value)) return false
  if (/^[{[]/.test(value)) return false
  return true
}

/**
 * 从环境变量里挑出可能是凭证的值。
 *
 * 名字像密钥（`*_KEY` / `*_TOKEN` / `*_SECRET` …）且长得不像路径的值才算数。
 */
export function collectEnvSecrets(env: Record<string, string | undefined>): string[] {
  const secrets: string[] = []
  for (const [name, value] of Object.entries(env)) {
    if (!value || !SECRET_NAME.test(name)) continue
    if (!looksLikeSecret(value)) continue
    secrets.push(value)
  }
  return secrets
}

/** URL 里可能带凭证的查询参数名。 */
const SECRET_QUERY_KEYS =
  /^(?:token|access[_-]?token|refresh[_-]?token|auth|authorization|secret|secret[_-]?key|key|api[_-]?key|pass(?:word)?|signature|sig|credential)s?$/i

/**
 * 把 URL 里的凭证抹掉，只留下能定位服务的部分。
 *
 * 日志里打印 NapCat 地址时用：token 常常就挂在查询串或 userinfo 上。
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.username = ""
    parsed.password = ""
    parsed.search = ""
    parsed.hash = ""
    return parsed.toString()
  } catch {
    return "[无法解析的地址]"
  }
}

/**
 * 取出 URL 里可能带凭证的值。
 *
 * 这些值要加进已知凭证，日志里的同一段内容才会被逐行打码。
 */
export function secretsFromUrl(url: string): string[] {
  const secrets: string[] = []
  try {
    const parsed = new URL(url)
    for (const [name, value] of parsed.searchParams) {
      if (!SECRET_QUERY_KEYS.test(name)) continue
      if (!value || value.length < MIN_SECRET_LENGTH) continue
      secrets.push(value)
    }
    for (const part of [parsed.username, parsed.password]) {
      if (part && part.length >= MIN_SECRET_LENGTH) secrets.push(part)
    }
  } catch {
    // 地址解析不了就没有凭证可取。
  }
  return secrets
}

/** 已知凭证明文写成的检测器。 */
function knownSecretDetector(secrets: string[]): Detector | undefined {
  if (secrets.length === 0) return undefined
  return {
    id: "known_secret",
    label: "Known secret",
    why: "环境里已知的凭证",
    pattern: new RegExp(secrets.map(escapeRegExp).join("|")),
    default: true,
  }
}

/** 指向凭证文件的路径。 */
const SENSITIVE_PATH_DETECTOR: Detector = {
  id: "sensitive_path",
  label: "Sensitive path",
  why: "指向凭证文件的路径",
  pattern: new RegExp(
    `(?:^|[\\s"'\`(=])[^\\s"'\`,;]*?(?:${SENSITIVE_PATH_PARTS.map(escapeRegExp).join("|")})(?:[/\\\\]|\\b|$)`,
    "i",
  ),
  default: true,
}

/** 判断解码结果是不是像人话，解出来是二进制就丢掉。 */
function looksLikeText(text: string): boolean {
  let printable = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    const ok =
      code === 9 ||
      code === 10 ||
      code === 13 ||
      (code >= 32 && code < 127) ||
      (code >= 0x4e00 && code <= 0x9fff)
    if (ok) printable += 1
  }
  return printable / text.length >= 0.85
}

/** 解一段 base64；解不出人话就返回 undefined。 */
function decodeBase64(input: string): string | undefined {
  const standard = input.replace(/-/g, "+").replace(/_/g, "/")
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4)
  const decoded = Buffer.from(padded, "base64").toString("utf8")
  if (decoded.length < 8) return undefined
  if (decoded.includes("\uFFFD")) return undefined
  if (!looksLikeText(decoded)) return undefined
  return decoded
}

/** 找出文本里藏着的 base64 变体。 */
function base64Variants(text: string): string[] {
  const runs = text.match(BASE64_RUN) ?? []
  const variants: string[] = []
  for (const run of runs.slice(0, MAX_BASE64_RUNS)) {
    const decoded = decodeBase64(run)
    if (decoded) variants.push(decoded)
  }
  return variants
}

/** 去掉分隔符，用来比对被拆开的凭证。 */
function compact(text: string): string {
  return text.replace(/[\s\-_.:/\\]+/g, "")
}

/**
 * 判断文本里有没有已知凭证的碎片。
 *
 * 凭证被空格、换行拆开时，正则匹配不上，但碎片还在。
 */
function containsFragment(text: string, secrets: string[]): boolean {
  if (secrets.length === 0) return false
  const compactText = compact(text)
  if (compactText.length < FRAGMENT_LENGTH) return false
  for (const secret of secrets) {
    const compactSecret = compact(secret)
    if (compactSecret.length < FRAGMENT_LENGTH) continue
    for (let i = 0; i + FRAGMENT_LENGTH <= compactSecret.length; i += 1) {
      if (compactText.includes(compactSecret.slice(i, i + FRAGMENT_LENGTH))) return true
    }
  }
  return false
}

export interface SensitiveCheckerOptions {
  /** 已知的凭证明文：环境变量里的密钥、NapCat 访问令牌等。 */
  knownSecrets?: string[]
  /** 是否启用检查，默认启用。 */
  enabled?: boolean
}

/**
 * 出站消息的敏感信息检查。
 *
 * 判定交给 flare-redact：凭证格式（各家 API key、JWT、Bearer、私钥、凭证赋值）
 * 都在它的检测器里；这里补三件它不管的事——环境里已知的凭证明文、
 * 全角与零宽字符的归一化、base64 变体。
 *
 * 命中就整条拦截：出站消息要么原样发出去，要么不发。
 */
export class SensitiveChecker {
  private readonly enabled: boolean
  private readonly knownSecrets: string[]
  private readonly custom: Detector[]
  private readonly only: string[]

  constructor(options: SensitiveCheckerOptions = {}) {
    this.enabled = options.enabled ?? true
    this.knownSecrets = (options.knownSecrets ?? []).filter(
      (secret) => secret.length >= MIN_SECRET_LENGTH,
    )
    const known = knownSecretDetector(this.knownSecrets)
    this.custom = known ? [known, SENSITIVE_PATH_DETECTOR] : [SENSITIVE_PATH_DETECTOR]
    this.only = [...SECRET_DETECTORS, ...this.custom.map((detector) => detector.id)]
  }

  /**
   * 检查一段即将发出的内容。
   *
   * @param text 即将发出去的文本。
   * @returns 放行时 `allowed` 为真；命中敏感信息时带上原因与命中的检测器。
   */
  check(text: string): SensitiveVerdict {
    if (!this.enabled || text.trim() === "") return CLEAN
    const normalized = normalizeText(text)
    const variants = [normalized, ...base64Variants(normalized)]
    const hits = new Map<string, SensitiveHit>()
    for (const variant of variants) {
      for (const finding of scan(variant, { only: this.only, custom: this.custom })) {
        hits.set(finding.detector, { detector: finding.detector, why: finding.why })
      }
    }
    if (containsFragment(variants.join("\n"), this.knownSecrets)) {
      hits.set("known_secret", { detector: "known_secret", why: "环境里已知的凭证" })
    }
    if (hits.size === 0) return CLEAN
    const detectors = [...hits.values()].map((hit) => hit.detector)
    return {
      allowed: false,
      hits: [...hits.values()],
      reason: `出站消息包含疑似敏感信息（${detectors.join("、")}），已拦截，没有发出去。请删掉这些凭证后再发一次。`,
    }
  }
}

/** 日志打码的选项。 */
export interface MaskOptions {
  /** 已知的凭证明文：环境变量里的密钥、NapCat 访问令牌等。 */
  knownSecrets?: string[]
}

/**
 * 给日志打码：把凭证换成占位符，其余内容原样留下。
 *
 * 用的是出站拦截同一套检测器（`SECRET_DETECTORS`）：邮箱、卡号、IBAN 不在内，
 * 群聊里的正常内容不会被误伤。环境里已知的凭证明文用 `known_secret` 额外兜住。
 *
 * 日志是「打码」不是「拦截」——整行照常写下来，只是凭证本身不落到文件里。
 *
 * @param text 已经序列化好的一行日志。
 * @param options 已知凭证明文等附加条件。
 * @returns 打码后的文本；脱敏器出错时整行换成 `[REDACTED]`，宁可少写也不写漏。
 */
export function maskSecrets(text: string, options: MaskOptions = {}): string {
  if (text === "") return text
  const knownSecrets = (options.knownSecrets ?? []).filter(
    (secret) => secret.length >= MIN_SECRET_LENGTH,
  )
  const known = knownSecretDetector(knownSecrets)
  const custom = known ? [known] : []
  const only = [...SECRET_DETECTORS, ...custom.map((detector) => detector.id)]
  try {
    // 原文里匹配不到时，再检查归一化后的副本：全角 / 零宽混淆的凭证
    // 出站拦截能识别，日志也不能原样写出去。无法安全回写位置，整行丢弃。
    const normalized = normalizeText(text)
    if (normalized !== text) {
      const hits = scan(normalized, { only, custom })
      if (hits.length > 0 || containsFragment(normalized, knownSecrets)) return "[REDACTED]"
    }
    return redact(text, {
      only,
      custom,
      mask: ({ detector }) => `[REDACTED:${detector.id}]`,
    })
  } catch {
    return "[REDACTED]"
  }
}
