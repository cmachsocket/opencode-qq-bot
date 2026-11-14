/**
 * 原型安全的小工具。
 *
 * 配置里的键名（配置档名、聊天键）都是用户可控的：直接拿它们去索引普通对象，
 * `__proto__`、`constructor` 这类名字会命中 `Object.prototype` 上的属性，
 * 于是「这个档存在吗」这类判断永远为真，运行时再拿原型当配置档用就崩了。
 *
 * 这里统一两件事：映射一律用没有原型的字典，查找一律用自有属性判断。
 */

/** 不能用作键名的属性名：它们会落到原型上。 */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"])

/** 建一个没有原型属性的字典。 */
export function safeMap<T = unknown>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

/** 键名是否安全：不能是原型上的属性名。 */
export function isSafeKey(name: string): boolean {
  return !RESERVED_KEYS.has(name)
}

/** 对象里是否真的有这个自有键。 */
export function hasKey(target: object, key: string): boolean {
  return Object.hasOwn(target, key)
}

/**
 * 把源对象里的键搬进一个没有原型的字典。
 *
 * 键名是用户给的：直接 `target[key] = value` 会踩到 `__proto__` 的 setter，
 * 键会变成原型上的属性，序列化时还会丢掉。
 */
export function copyToSafeMap<T = unknown>(
  source: Record<string, unknown>,
  target: Record<string, T> = safeMap<T>(),
): Record<string, T> {
  for (const [key, value] of Object.entries(source)) {
    Object.defineProperty(target, key, {
      value: value as T,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return target
}
