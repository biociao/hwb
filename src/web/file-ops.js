// hwb 侧的文件搬运：下载到本机 / 上传回工作区。
//
// 调用方只有 app.js 的消息处理：dsh 侧栏里注入的控件（documentpreview 头部的「下载到本机」、
// sidebar-files 头部的「上传到此处」）把动作转给父页，真正发请求的是这里。
// 鉴权、工作区围栏、256 MiB 上限与上传并发闸门都在服务端（src/api/routes.js），
// 这一层只管进度与失败信息 —— 注入到 dsh 页面里的代码不碰这些。

// 与后端 src/lib/file-preview.js 的 UPLOAD_BYTES 保持一致：超限文件在本地就给提示，
// 不必先把几百 MiB 发给服务端再被拒。服务端仍是唯一权威（它自己也会挡）。
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
// 单次中继的文件数上限：纯粹防「一次选中几千个文件」把父子之间的消息与串行上传拖成不可控，
// 正常使用（拖一批产物回去）远达不到这个数。
export const MAX_UPLOAD_FILES = 200;

/**
 * 按 256 MiB 上限把选中的文件分成「可传」与「超限」两组。
 * 超限的在本地就拦下，不必先把几百 MiB 发给服务端再被拒（服务端仍会自己挡一遍）。
 * @param {Array<{size?: number}>} files - 桥接转过来的 File 清单。
 * @param {number} maxBytes - 单文件上限。
 * @returns {{accepted: Array, oversize: Array}}
 */
export function partitionUploads(files, maxBytes = MAX_UPLOAD_BYTES) {
  const accepted = [];
  const oversize = [];
  for (const file of files || []) (Number(file?.size) > maxBytes ? oversize : accepted).push(file);
  return { accepted, oversize };
}

/** 把文件本体取回本机：本机实例直读，远端实例经 SSH 传回（都在服务端完成）。 */
export async function downloadFile(homeId, params, file) {
  const response = await fetch(`/api/homes/${homeId}/download?` + new URLSearchParams({ ...params, path: file }));
  if (!response.ok) {
    let detail = {};
    try { detail = await response.json(); } catch { /* 非 JSON 即按 HTTP 状态处理 */ }
    throw new Error(detail.error || `HTTP ${response.status}`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file.split('/').pop() || 'download';
  document.body.append(link);
  link.click();
  link.remove();
  // 立即 revoke 会让部分浏览器来不及取字节（下载刚开始就被掐断），所以留一段时间。
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/**
 * 逐个串行上传：进度条是「整批」语义，同时开多条只会互相抢带宽、报错也难定位。
 * @returns {Promise<{uploaded: number, renamed: string[], failed: string[]}>} 全部失败时抛错。
 */
export async function uploadFiles(homeId, params, dir, files, onProgress, { put = putFile } = {}) {
  const renamed = [];
  const failed = [];
  for (const [index, file] of files.entries()) {
    try {
      const written = await put(homeId, params, dir, file, (share) => {
        onProgress?.(Math.round(((index + share) / files.length) * 100), file);
      });
      if (written?.name && written.name !== file.name) renamed.push(`${file.name} → ${written.name}`);
    } catch (e) { failed.push(`${file.name}（${e.message}）`); }
  }
  return { uploaded: files.length - failed.length, renamed, failed };
}

/** 单个文件：PUT multipart 到 /api/homes/:id/upload，回报 0..1 的进度。 */
function putFile(homeId, params, dir, file, onProgress) {
  return new Promise((resolve, reject) => {
    const query = new URLSearchParams({ ...params, dir });
    const request = new XMLHttpRequest();
    request.open('PUT', `/api/homes/${homeId}/upload?${query}`);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    request.onload = () => {
      let data = {};
      try { data = JSON.parse(request.responseText); } catch { /* 非 JSON 即按 HTTP 状态处理 */ }
      if (request.status >= 200 && request.status < 300) resolve(data.files?.[0]);
      // 服务端在超过上限时会直接断开连接：没有 JSON 可解析，这里给一个能自解释的提示。
      else reject(new Error(data.error || (request.status ? `HTTP ${request.status}` : '文件可能超过 256 MiB 上限，上传被中断')));
    };
    request.onerror = () => reject(new Error('网络错误，上传未完成'));
    request.onabort = () => reject(new Error('上传已取消'));
    const body = new FormData();
    body.append('file', file, file.name);
    request.send(body);
  });
}
