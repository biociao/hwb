// 毫秒时间戳 → ISO 字符串的统一转换。
//
// 为什么不能直接 `new Date(v).toISOString()`：ECMAScript 的日期时间戳有效范围是
// ±8.64e15 毫秒（约 ±275760 年），超出后 `toISOString()` 抛 `RangeError: Invalid time value`，
// 而 `Number.isFinite(v)` 依旧为 true —— 也就是说「有限」并不等于「可转日期」。
// dsh 元数据里的时间戳来自外部（projcache 投影 / 实时 RPC），一旦单位写错（纳秒、微秒当毫秒用）
// 就会出现 1e300 这类值；此时若让异常抛出，整条读取路径会被判为 degraded，
// 用户看到的是该实例的会话/状态凭空消失 —— 代价远大于「这一个字段暂时不可用」。
//
// 因此统一降级为 null，由调用方决定怎么展示。

/** ECMAScript 时间戳有效上界（毫秒）。 */
export const MAX_TIMESTAMP_MS = 8.64e15;

/** 合法毫秒时间戳 → ISO 字符串；非法/超范围/非数字 → null。 */
export function msToIso(value) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_TIMESTAMP_MS
    ? new Date(value).toISOString()
    : null;
}
