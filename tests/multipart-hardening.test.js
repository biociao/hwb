import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { parseMultipart } from '../src/lib/multipart.js';

// multipart 解析器的两处回归：
//  1) 分隔符扫描的复杂度。原生实现是「每个 cursor 都从当前位置重扫整个剩余缓冲区」，
//     在「缓冲区里没有分隔符」这个文件内容的常态下退化成 O(n²)：实测 64 KiB 内容块 36 ms，
//     合法的 256 MiB 上传会把事件循环冻住约 3 分钟 —— 期间工作台的 SSE、监控心跳、
//     所有 API 全部停止响应（单进程、单线程）。
//  2) 浏览器发的 filename 是**原样**的（不做百分号编码），含裸 `%` 的合法文件名
//     会让 decodeURIComponent 抛 URIError，整个上传被拒。
// 注意：CI 上跑时间断言有风险，这里用的是极大的安全余量（修复后 ~5 ms，阈值 1500 ms）。

const CRLF = '\r\n';

function body(boundary, filename, bytes) {
  return Buffer.concat([
    Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}`
      + `Content-Type: application/octet-stream${CRLF}${CRLF}`),
    Buffer.alloc(bytes, 0x41),
    Buffer.from(`${CRLF}--${boundary}--${CRLF}`),
  ]);
}

async function parse(buf, boundary, chunkSize = 64 * 1024) {
  const req = Readable.from((function* () {
    for (let i = 0; i < buf.length; i += chunkSize) yield buf.subarray(i, i + chunkSize);
  })());
  req.headers = { 'content-length': String(buf.length) };
  let received = 0;
  await parseMultipart(req, {
    boundary,
    maxBytes: 512 * 1024 * 1024,
    onFileStart: () => true,
    write: (chunk) => { received += chunk.length; },
  });
  return received;
}

test('分隔符扫描：8 MiB 上传必须线性完成，不能退化成 O(n²)', async () => {
  const boundary = '----hwbPerfBoundary123456';
  const buf = body(boundary, 'big.bin', 8 * 1024 * 1024);
  const started = performance.now();
  const received = await parse(buf, boundary);
  const elapsed = performance.now() - started;

  assert.equal(received, 8 * 1024 * 1024, '内容字节数必须与写入一致');
  // 修复前：64 KiB 分片每块约 36 ms ⇒ 128 块约 4.6 s（256 MiB 时约 3 分钟）。
  // 修复后：同样数据量约 5 ms。阈值取 1500 ms，留 ~300 倍余量避免慢机器误报。
  assert.ok(elapsed < 1500, `8 MiB 解析耗时 ${elapsed.toFixed(0)} ms，超过 1500 ms —— 分隔符扫描疑似又退化成 O(n²)`);
});

test('分隔符扫描：数据量翻 4 倍时耗时不应接近翻 16 倍（二次增长特征）', async () => {
  const boundary = '----hwbScaleBoundary123456';
  // 取**多次运行的最小值**：最小值反映算法本身，受调度噪声影响远小于单次测量。
  // （第一版用单次测量 + ratio<8，在整个测试套件并行跑、机器繁忙时会偶发假失败。）
  const bestOf = async (mb, runs = 5) => {
    const buf = body(boundary, 'x.bin', mb * 1024 * 1024);
    await parse(buf, boundary); // JIT 预热
    let best = Infinity;
    for (let i = 0; i < runs; i++) {
      const t = performance.now();
      await parse(buf, boundary);
      best = Math.min(best, performance.now() - t);
    }
    return best;
  };
  const small = await bestOf(2);
  const large = await bestOf(8);
  const ratio = large / small;
  // 线性约 4 倍、二次约 16 倍：要求明显低于二次，同时给慢机器/繁忙机器留足余量。
  assert.ok(ratio < 10, `4 倍数据耗时放大 ${ratio.toFixed(1)} 倍（二次增长约 16 倍）—— 扫描疑似重新退化成 O(n²)`);
  // 绝对量兜底：8 MiB 若真退化成 O(n²) 会是秒级
  assert.ok(large < 1500, `8 MiB 解析最快要 ${large.toFixed(0)} ms，超过 1500 ms`);
});

test('文件名含裸 % 时按原样使用，不再因 decodeURIComponent 抛 URIError 拒掉整个上传', async () => {
  const boundary = '----hwbPctBoundary123456';
  for (const name of ['100% done.csv', '100%.csv', 'a%zz.txt', 'R&D 100% x.csv']) {
    const buf = body(boundary, name, 16);
    const req = Readable.from([buf]);
    req.headers = { 'content-length': String(buf.length) };
    const seen = [];
    await parseMultipart(req, { boundary, maxBytes: 1024 * 1024,
      onFileStart: (n) => { seen.push(n); return true; }, write: () => {} });
    assert.deepEqual(seen, [name], `${name} 应原样通过`);
  }
});

test('文件名确实被百分号编码时仍然解码（保持旧客户端行为）', async () => {
  const boundary = '----hwbEncBoundary123456';
  const buf = body(boundary, encodeURIComponent('中文 name.txt'), 16);
  const req = Readable.from([buf]);
  req.headers = { 'content-length': String(buf.length) };
  const seen = [];
  await parseMultipart(req, { boundary, maxBytes: 1024 * 1024,
    onFileStart: (n) => { seen.push(n); return true; }, write: () => {} });
  assert.deepEqual(seen, ['中文 name.txt']);
});
