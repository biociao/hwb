export function normalizeAccessPort(value) {
  if (value == null || value === '') return null;
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) {
    throw new Error('本地端口必须为 1–65535 的整数，或留空自动分配');
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('本地端口必须为 1–65535 的整数');
  return port;
}
