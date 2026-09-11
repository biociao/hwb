// 流式 multipart/form-data 解析（只支持单文件字段，够 hwb 的上传用）。
//
// 为什么不走「整包进内存」：单文件上限 256 MiB，一次性收集会让常驻工作台进程多背一份
// 同等大小的 Buffer，而且 UTF-8 解码会让中文内容体积再涨 1/3。这里把请求体按到达顺序
// 边解析边写盘：文件字节直接交给 write(chunk) 落盘，内存里只保留「可能是分隔符开头」
// 的尾巴（≤ 分隔符长度 + 3）。
//
// 依赖两个前提，都在调用方（路由）保证：
//   · Content-Length 存在（上传用 XHR 发送 File，浏览器会自动带长度）；缺失时直接拒绝，
//     因为不做 chunked 解码就无法在写盘前设限。
//   · 只接受单文件字段，多余部分一律报错而不是静默丢数据。
export function parseMultipart(req, { boundary, maxBytes, onFileStart, write, onSettle }) {
  // 分隔符一律带前导 CRLF：只匹配 `--boundary` 会误伤头部里的子串（如 "multipart/form-data"
  // 里的 "--b"），也会让「part 体里的 CRLF」和「分隔符前缀」无法区分。
  const delimiter = `\r\n--${boundary}`;
  const open = `--${boundary}`;       // 首个分隔符没有前导 CRLF（body 直接从它开始）
  const start = `${open}\r\n`;      // 第一个 part 之前的那一个
  const close = delimiter;           // part 体的收尾
  const end = `${delimiter}--`;      // 结束分隔符（field 状态用它找 part 尾巴）
  const hold = delimiter.length + 4; // 留足「分隔符可能还没读完」的尾巴
  const headLimit = 64 * 1024;   // 头部（Content-Disposition 等）上限

  const contentLength = Number(req.headers?.['content-length']) || 0;
  if (!Number.isInteger(contentLength) || contentLength <= 0) {
    onSettle?.('failed', '上传请求缺少 Content-Length');
    return Promise.reject(new Error('上传请求缺少 Content-Length'));
  }
  if (contentLength > maxBytes + 2 * headLimit) {
    const tooBig = `文件超过 ${Math.floor(maxBytes / (1024 * 1024))} MiB 上限`;
    onSettle?.('failed', tooBig);
    return Promise.reject(new Error(tooBig));
  }
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let received = 0, expected = contentLength, state = 'preamble';
    let partOpen = false; // 当前 part 头部是否已出现 content-disposition（决定空行之后进 body 还是继续读头部）
    let flush = false; // 流已结束：consume 必须把「缓冲里的剩余数据」当作最终状态来判定
    let settled = false;
    // onSettle 只是「有结果了」的通知（不做任何控制流），供调用方在流驱动场景里
    // 明确拿到失败信号——否则失败只体现在一个可能被忽略的 Promise 拒绝上。
    const fail = (message) => { if (!settled) { settled = true; reject(new Error(message)); onSettle?.('failed', message); } };
    const done = (value) => { if (!settled) { settled = true; resolve(value); onSettle?.('done'); } };

    // 只读缓冲的前 n 字节：读到的数据不立刻丢弃，缓冲区就必须一直留着（见 push 里的说明），
    // 这样无论分隔符被拆成几个 TCP 分片，都不会漏匹配。
    const take = (n) => { const out = buffer.subarray(0, n); buffer = buffer.subarray(n); return out; };
    const indexOf = (needle, from = 0) => buffer.indexOf(needle, from);
    // Read one header line; take() returns a view on the shared buffer, so copy the text out.
    const readLine = () => {
      const at = indexOf('\r\n');
      if (at < 0) return null;
      const line = Buffer.from(buffer.subarray(0, at)).toString('utf8');
      take(at + 2);
      return line;
    };
    // 写盘失败（磁盘满、写坏路径、超限）必须立刻终止整个上传：把它压进 errors 再继续解析，
    // 会让 Promise 一直悬着（实测写成“resolved 但一个字节都没落盘”）。
    const safeWrite = (chunk) => { try { write(chunk); } catch (e) { throw e; } };
    // 缓冲区开头那 hold 字节可能只是「分隔符还没读全」的残片，必须留着；其余都是确凿的文件内容，
    // 立刻写盘并从缓冲里丢掉——否则恒定内存就无从谈起（大文件会在缓冲里堆满）。
    const keepTail = () => { if (buffer.length > hold) safeWrite(take(buffer.length - hold)); };

    function consume() {
      for (;;) {
        if (state === 'preamble') {
          const at = indexOf(start);
          if (at >= 0) { take(at + start.length); state = 'headers'; continue; }
          // 还没看到起始分隔符。multipart 正文必须以 `--boundary` 开头（允许前面有 CRLF），
          // 所以一旦前几个字节不是这两种开头，就肯定不是 multipart：立即报错，
          // 不要一直等到收完才报“不完整”（那样错误信息会误导排查）。
          const head = buffer.subarray(0, Math.min(buffer.length, start.length)).toString('latin1');
          const partial = start.startsWith(head) || start.startsWith(head.slice(1));
          if (!partial) return fail('上传请求格式无效');
          if (buffer.length > hold) take(buffer.length - hold);
          return false;
        } else if (state === 'afterBoundary') {
          // 分隔符后面必须是 `\r\n`（下一个 part）或 `--`（结束）。流已结束还不足 2 字节，
          // 说明尾部分隔符被截断；不能一直等下去（那样请求会悬着）。
          if (flush && buffer.length < 2) return fail('上传请求格式无效');
          if (buffer.length < 2) return false;
          if (buffer[0] === 0x2d && buffer[1] === 0x2d) { // `--`：收尾分隔符，后面只剩 CRLF
            const at = indexOf('\r\n');
            if (at < 0) return false;
            take(at + 2);
            state = 'done';
          } else if (buffer[0] === 0x0d && buffer[1] === 0x0a) {
            take(2);
            state = 'headers';
          } else return fail('上传请求格式无效');
        } else if (state === 'headers') {
          // header 末尾的空行只剩 CRLF 时，即使流已结束也要先把它吃掉。
          if (flush && buffer.length < 2) return fail('上传请求不完整');
          if (buffer.length < 2) return false;
          if (buffer[0] === 0x0d && buffer[1] === 0x0a) {
            // 空行 = header 结束。这里必须主动把它吃掉（而不是交给下一轮），否则那 2 个字节会残留在缓冲区里，
            // 被 body 状态当成文件内容的开头（整个 part 就会整体偏移 2 字节）。
            take(2);
            // 只有当前 part 是文件 part（已见 filename）时，空行才意味着“body 开始”；
            // 否则（普通字段 / 还没看到 Content-Disposition）继续读下一个 header。
            if (!partOpen) continue;
            state = 'body';
          } else {
            const dispo = readLine();
            if (dispo === null) { if (buffer.length > headLimit) return fail('上传头部过大'); return false; }
            if (/^content-disposition:/i.test(dispo)) {
              const match = /^content-disposition:\s*form-data;\s*name="(?<name>[^"]*)"(?:;\s*filename="(?<filename>[^"]*)")?/i.exec(dispo);
              if (!match) return fail('上传请求格式无效');
              if (!match.groups.filename) { state = 'field'; continue; } // 非文件字段（如 dir）：值在 body 里，读完丢弃
              partOpen = true;
              try {
                if (!onFileStart(decodeURIComponent(match.groups.filename))) return fail('上传请求格式无效');
              } catch (e) { return fail(e.message || '文件名无效'); }
            }
          }
        } else if (state === 'body') {
          // 取**最早出现的完整分隔符**，而不是最后一个：
          //   · `\r\n--boundary` 后面跟 `\r\n`（下一个 part）或 `--`（结束）才算完整；
          //   · 只匹配前缀就把分隔符前面全部当内容写出去——这样文件内容与分隔符永远不会被混淆，
          //     也天然避免了「最后写出去的恰好是文件内容」这条歧义路径；
          //   · 找不到完整分隔符时就保留末尾 hold 字节（可能只是分隔符的一部分）继续等数据，
          //     其余立刻写盘，因此缓冲区占用与文件大小无关。
          let at = -1;
          for (let cursor = 0; cursor <= buffer.length - delimiter.length - 2; cursor++) {
            if (buffer.indexOf(delimiter, cursor) !== cursor) continue;
            const next = delimiter.length + cursor;
            if ((buffer[next] === 0x0d && buffer[next + 1] === 0x0a) || (buffer[next] === 0x2d && buffer[next + 1] === 0x2d)) { at = cursor; break; }
          }
          if (at < 0) {
            if (flush) return fail('\u4e0a\u4f20\u8bf7\u6c42\u4e0d\u5b8c\u6574');
            keepTail();
            return false;
          }
          if (at > 0) safeWrite(take(at));
          take(delimiter.length);
          state = 'afterBoundary';
        } else if (state === 'field') {
          const at = indexOf(end);
          if (at < 0) { if (buffer.length > headLimit * 8) return fail('上传请求格式无效'); return false; }
          take(at + end.length);
          state = 'done';
        } else if (state === 'done') {
          return true;
        }
      }
    }

    function push(chunk) {
      if (settled) return;
      received += chunk.length;
      // 用 Content-Length 先把住上限：多读一段就可能多落一段盘，不如早拒。
      if (received > expected + 2 * hold + 4096) return fail(`上传内容超过 ${Math.floor(maxBytes / (1024 * 1024))} MiB 上限`);
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      let finished;
      try {
        finished = consume();
      } catch (e) {
        req.pause?.();       // 别再白读剩下的包
        return fail(e.message || '上传写入失败');
      }
      if (finished === true) { req.resume?.(); return done(null); }
    }

    req.on('data', push);
    req.on('end', () => {
      if (settled) return;
      // 先带着「已结束」标记跑一轮：收尾分隔符可能正好落在最后一个分片里。
      flush = true;
      try {
        if (consume() === true) return done(null);
      } catch (e) { return fail(e.message || '上传写入失败'); }
      if (state !== 'done') return fail('上传请求不完整');
      done(null);
    });
    req.on('error', (e) => fail(e.message || '上传中断'));
    // 客户端中途断开（req 的 aborted/close）：不能让 Promise 悬着，否则请求永不返回。
    req.on('aborted', () => fail('上传已中断'));
    req.on('close', () => { if (!settled && state !== 'done') fail('上传已中断'); });
  });
}
