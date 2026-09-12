import { api, esc } from '../store.js';
import { attachPreviewResize } from './preview-resize.js';
import { renderPreviewImage } from './preview-image.js';
import { renderPreviewHtml } from './preview-html.js';

// 与后端 src/lib/file-preview.js 的 UPLOAD_BYTES 保持一致：拖入超限文件时在本地就给提示，
// 不必先把几百 MiB 发给服务端再被拒。服务端仍是唯一权威（它自己也会挡）。
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

export function attachFilePreview(pane, homeId) {
  const toggle = document.createElement('button');
  toggle.className = 'preview-toggle';
  toggle.textContent = '文件预览';
  toggle.title = '打开文件预览';
  toggle.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
  const aside = document.createElement('aside');
  aside.className = 'file-preview';
  aside.hidden = true;
  aside.setAttribute('aria-label', '文件预览');
  aside.innerHTML = `<header><strong>文件预览</strong>
      <select data-workspace aria-label="选择要预览的工作区" hidden></select>
      <button data-close aria-label="关闭文件预览">×</button></header>
    <div class="preview-workspace" aria-label="当前工作区">跟随当前会话工作区</div>
    <form><input aria-label="文件路径" placeholder="相对路径或项目内绝对路径"><button>打开</button></form>
    <nav><button data-up disabled>↑ 上级</button><button data-root>项目根目录</button><button data-refresh>刷新</button><button data-download disabled>下载文件</button></nav>
    <div class="download-status" role="status"></div>
    <section class="upload-zone" aria-label="上传文件">
      <div class="upload-row">
        <button type="button" data-upload disabled>选择文件上传</button>
        <span class="upload-hint" data-upload-hint>或将文件拖到此处（单个文件最大 256 MiB，同名自动改名）</span>
      </div>
      <input type="file" multiple hidden aria-label="选择要上传的文件">
      <div class="upload-progress" hidden><progress max="100" value="0"></progress><span class="upload-progress-text"></span></div>
    </section>
    <div class="preview-path"></div><div class="preview-content" aria-live="polite">点击会话中的文件路径，或浏览当前工作区。</div>`;
  document.getElementById('preview-actions').append(toggle);
  pane.el.append(aside);
  const disposeResize = attachPreviewResize(pane, aside, homeId);
  const workspaceLabel = aside.querySelector('.preview-workspace');
  const workspacePick = aside.querySelector('[data-workspace]');
  const input = aside.querySelector('input[aria-label="文件路径"]');
  const content = aside.querySelector('.preview-content');
  const pathLabel = aside.querySelector('.preview-path');
  const up = aside.querySelector('[data-up]');
  const download = aside.querySelector('[data-download]');
  const downloadStatus = aside.querySelector('.download-status');
  const uploadZone = aside.querySelector('.upload-zone');
  const uploadButton = aside.querySelector('[data-upload]');
  const uploadHint = aside.querySelector('[data-upload-hint]');
  const fileInput = aside.querySelector('input[type="file"]');
  const progressBox = aside.querySelector('.upload-progress');
  const progress = progressBox.querySelector('progress');
  const progressText = progressBox.querySelector('.upload-progress-text');
  let disposeImage = () => {}, downloading = false, uploading = false;
  let current = null, sequence = 0, sessionId = null;
  // 预览目标：优先跟随内嵌页上报的会话（sessionId），否则用户可直接从 hwb 索引里选一个
  // 工作区（workspaceId）。后者是兜底——内嵌页未上报会话时（例如 dsh 的 URL 不带 ?session=），
  // 侧栏仍然可用，不必先去 dsh 里点开一个会话。
  let bound = null;
  const boundQuery = () => (bound?.sessionId ? { sessionId: bound.sessionId } : { workspaceId: bound?.workspaceId });
  const bindTo = (next) => {
    const same = bound?.sessionId === next?.sessionId && bound?.workspaceId === next?.workspaceId;
    if (same) return false;
    bound = next;
    sequence++;
    current = null;
    disposeImage();
    disposeImage = () => {};
    download.disabled = true;
    input.value = '';
    pathLabel.textContent = '';
    workspaceLabel.textContent = '跟随当前会话工作区';
    up.disabled = true;
    uploadButton.disabled = true;
    uploadZone.classList.remove('can-upload');
    return true;
  };
  function setContext(data) {
    const next = typeof data.sessionId === 'string' ? data.sessionId : null;
    if (next === sessionId) return false;
    sessionId = next;
    // 会话上下文到达 → 覆盖手动选择；会话上下文消失（切到无会话的实例）→ 退回手动模式。
    bindTo(next ? { sessionId: next } : (workspacePick.value ? { workspaceId: workspacePick.value } : null));
    return true;
  }
  const DEFAULT_HINT = uploadHint.textContent;
  function show() { aside.hidden = false; pane.el.classList.add('has-preview'); toggle.setAttribute('aria-expanded', 'true'); toggle.title = '关闭文件预览'; }
  function close() { sequence++; disposeImage(); aside.hidden = true; pane.el.classList.remove('has-preview'); toggle.setAttribute('aria-expanded', 'false'); toggle.title = '打开文件预览'; toggle.focus(); }
  // 拖拽上传：只在「预览的是目录」且拖入的是文件时接收；详情见 README「文件预览侧边栏」。
  const hasFiles = (dt) => Array.from(dt?.types || []).includes('Files');
  const canUpload = () => Boolean(bound) && current?.kind === 'directory' && !uploading;
  // 工作区下拉：兜底入口。hwb 索引里本来就有这台实例的全部工作区（含远端路径），
  // 因此即使内嵌页没有上报会话，侧栏也能直接浏览/上传，不必先去 dsh 里点开一个会话。
  let workspaces = [];
  function renderWorkspacePicker() {
    if (!workspaces.length) { workspacePick.hidden = true; return; }
    workspacePick.hidden = false;
    const manual = bound?.sessionId ? '' : (bound?.workspaceId || '');
    workspacePick.innerHTML = `<option value="">（跟随 dsh 会话）</option>`
      + workspaces.map((w) => `<option value="${esc(w.workspaceId)}"${w.workspaceId === manual ? ' selected' : ''}>${esc(w.title || w.project || w.workspaceId)}</option>`).join('');
  }
  async function loadWorkspaces() {
    if (workspaces.length) return workspaces;
    try {
      const data = await api(`/api/workspaces?homeId=${encodeURIComponent(homeId)}`);
      workspaces = (data.workspaces || []).filter((w) => w.path && !w.archived);
      workspacePick.disabled = !workspaces.length;
    } catch { workspaces = []; }
    return workspaces;
  }
  // 首次打开面板：把工作区列表准备好；若还没有会话上下文，则自动绑定最近活跃会话所在的工作区。
  async function primeWorkspace() {
    await loadWorkspaces();
    if (bound || !workspaces.length) { renderWorkspacePicker(); return; }
    try {
      const { sessions } = await api(`/api/sessions/recent?homeId=${encodeURIComponent(homeId)}&limit=50`);
      const recent = (sessions || []).find((item) => item.workspaceId && workspaces.some((w) => w.workspaceId === item.workspaceId));
      if (recent) bindTo({ workspaceId: recent.workspaceId });
    } catch { /* 没有历史会话就等用户自己选 */ }
    renderWorkspacePicker();
  }
  function setHint(text, tone) {
    uploadHint.textContent = text;
    uploadHint.className = `upload-hint${tone ? ` ${tone}` : ''}`;
  }
  function uploadOne(index, total, file) {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({ ...boundQuery(), dir: current.path });
      const request = new XMLHttpRequest();
      request.open('PUT', `/api/homes/${homeId}/upload?${params}`);
      request.upload.onprogress = (e) => {
        if (!e.lengthComputable) return;
        const share = (index + e.loaded / e.total) / total;
        progress.value = Math.round(share * 100);
        progressText.textContent = `${Math.round(share * 100)}% · ${file.name}（${index + 1}/${total}）`;
      };
      request.onload = () => {
        let data = {};
        try { data = JSON.parse(request.responseText); } catch { /* 非 JSON 即按 HTTP 状态处理 */ }
        if (request.status >= 200 && request.status < 300) resolve(data);
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
  // 逐个串行上传：进度条是「整批」语义，同时开多条只会互相抢带宽、报错也难定位。
  async function uploadFiles(list) {
    if (!canUpload() || !list.length) return;
    const rejected = [];
    const files = [];
    for (const file of list) {
      if (file.size > MAX_UPLOAD_BYTES) rejected.push(file.name);
      else files.push(file);
    }
    if (rejected.length) setHint(`已跳过 ${rejected.join('、')}：超过 ${MAX_UPLOAD_BYTES / (1024 * 1024)} MiB 上限`, 'warn');
    if (!files.length) return;
    const target = current.path;
    uploading = true;
    uploadButton.disabled = true;
    uploadZone.classList.remove('can-upload');
    progressBox.hidden = false;
    progress.value = 0;
    progressText.textContent = `0% · ${files[0].name}（1/${files.length}）`;
    setHint('正在上传…');
    const renamed = [];
    const failed = [];
    for (const [index, file] of files.entries()) {
      try {
        const data = await uploadOne(index, files.length, file);
        const written = data.files?.[0];
        if (written && written.name !== file.name) renamed.push(`${file.name} → ${written.name}`);
      } catch (e) { failed.push(`${file.name}（${e.message}）`); }
    }
    uploading = false;
    progressBox.hidden = true;
    progress.value = 0;
    if (failed.length) setHint(`上传失败：${failed.join('；')}`, 'warn');
    else if (renamed.length) setHint(`已上传 ${files.length} 个文件；同名已改名：${renamed.join('，')}`, 'ok');
    else setHint(`已上传 ${files.length} 个文件到当前目录`, 'ok');
    // 目录内容变了：重新读一次当前目录（不影响用户已切换到的其他路径）。
    if (current?.path === target) await open(current.path);
    if (!bound) return;
    uploadButton.disabled = current?.kind !== 'directory';
  }
  async function open(file = '.', line = null) {
    show();
    const id = ++sequence;
    current = null;
    disposeImage();
    disposeImage = () => {};
    downloadStatus.textContent = '';
    download.disabled = !bound || downloading;
    up.disabled = true;
    input.value = file;
    content.textContent = '加载中…';
    try {
      if (!bound) {
        pathLabel.textContent = '';
        // 两条路都能用：右上角下拉直接选工作区，或在 dsh 里点开一个会话让它自动跟随。
        content.textContent = workspaces.length
          ? '未绑定会话：请在右上角下拉里选择一个工作区，或在 dsh 中打开项目会话（预览会自动跟随）。'
          : '这台实例还没有已登记的工作区：请先在 dsh 中打开一个项目会话，hwb 索引到工作区后即可预览。';
        return;
      }
      const result = await api(`/api/homes/${homeId}/preview?` + new URLSearchParams({ ...boundQuery(), path: file }));
      if (id !== sequence) return;
      current = result;
      download.disabled = result.kind === 'directory' || downloading;
      workspaceLabel.textContent = result.workspace?.title || result.workspace?.path || result.path;
      workspaceLabel.title = result.workspace?.path || result.path;
      pathLabel.textContent = result.path;
      pathLabel.title = result.path;
      input.value = result.path;
      up.disabled = !result.parent;
      uploadButton.disabled = !bound || result.kind !== 'directory' || uploading;
      if (result.kind === 'directory') {
        content.innerHTML = (result.entries.length ? result.entries.map((entry, i) => `<button class="preview-entry" data-entry="${i}"><span>${entry.kind === 'directory' ? '📁' : entry.kind === 'symlink' ? '↗' : '📄'}</span> ${esc(entry.name)}</button>`).join('') : '<p>空目录</p>') + (result.truncated ? '<p>仅显示前 200 项，可输入路径打开其他文件。</p>' : '');
      } else if (result.kind === 'image') {
        content.innerHTML = `<p class="preview-meta">${result.size.toLocaleString()} 字节</p>`;
        disposeImage = renderPreviewImage(content, result);
      } else if (result.kind === 'html') {
        // 默认渲染（iframe 取 /asset 的原字节），并保留「源码 / 在浏览器打开」出口。
        // 源码按需再取一次（服务端只回前 24 KiB），避免为了一个可选视图多传一遍元数据。
        const assetUrl = `/api/homes/${homeId}/asset?` + new URLSearchParams({ ...boundQuery(), path: result.path });
        const loadSource = () => api(`/api/homes/${homeId}/preview?` + new URLSearchParams({ ...boundQuery(), path: result.path, text: '1' }))
          .then((response) => (typeof response.content === 'string' ? response.content : ''))
          .catch((error) => { throw new Error(error.message); });
        content.innerHTML = '';
        disposeImage = renderPreviewHtml(content, result, { assetUrl, line, loadSource,
          onDownload: () => downloadFile(result.path) });
      } else if (result.binary) {
        content.textContent = `二进制文件，暂不支持内容预览（${result.size.toLocaleString()} 字节）。`;
      } else {
        content.innerHTML = `<p class="preview-meta">${result.size.toLocaleString()} 字节${result.truncated ? ' · 仅预览前 24 KiB' : ''}</p><pre>${result.content.split('\n').map((text, i) => `<span class="preview-line${i + 1 === line ? ' selected' : ''}" data-line="${i + 1}"><span class="line-number">${i + 1}</span>${esc(text)}\n</span>`).join('')}</pre>`;
        if (line) content.querySelector(`[data-line="${line}"]`)?.scrollIntoView({ block: 'center' });
      }
    } catch (e) {
      if (id === sequence) {
        pathLabel.textContent = file;
        content.textContent = `预览失败：${e.message}`;
        uploadButton.disabled = true;
      }
    }
  }
  toggle.onclick = async () => {
    if (!aside.hidden) { close(); return; }
    const wanted = input.value || '.';
    if (!bound) await primeWorkspace();
    await open(wanted);
  };
  aside.querySelector('[data-close]').onclick = close;
  aside.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  aside.querySelector('form').onsubmit = (e) => { e.preventDefault(); open(input.value || '.'); };
  up.onclick = () => current?.parent && open(current.parent);
  aside.querySelector('[data-root]').onclick = () => open('.');
  aside.querySelector('[data-refresh]').onclick = () => open(input.value || '.');
  download.onclick = () => downloadFile(current?.path || input.value);
  async function downloadFile(file) {
    if (!bound || !file || downloading) return;
    const request = sequence;
    downloading = true;
    download.disabled = true;
    downloadStatus.textContent = '正在下载完整文件…';
    try {
      const response = await fetch(`/api/homes/${homeId}/download?` + new URLSearchParams({ ...boundQuery(), path: file }));
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || `HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = file.split('/').pop();
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      if (request === sequence) downloadStatus.textContent = '已交给浏览器保存。';
    } catch (e) {
      if (request === sequence) downloadStatus.textContent = `下载失败：${e.message}`;
    } finally {
      downloading = false;
      download.disabled = !bound || current?.kind === 'directory';
    }
  }
  content.onclick = (e) => {
    const button = e.target.closest('[data-entry]');
    if (button && current?.kind === 'directory') open(`${current.path.replace(/\/$/, '')}/${current.entries[Number(button.dataset.entry)].name}`);
  };
  workspacePick.onchange = async () => {
    bindTo(workspacePick.value ? { workspaceId: workspacePick.value } : null);
    await open('.');
    renderWorkspacePicker();
  };
  uploadButton.onclick = () => { if (canUpload()) fileInput.click(); };
  fileInput.onchange = () => {
    const files = [...fileInput.files];
    fileInput.value = ''; // 同一个文件连传两次也要能触发 change
    uploadFiles(files);
  };
  // dragenter/dragover 必须 preventDefault，否则浏览器会直接打开被拖入的文件。
  uploadZone.ondragenter = uploadZone.ondragover = (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = canUpload() ? 'copy' : 'none';
    if (canUpload()) uploadZone.classList.add('can-upload');
  };
  uploadZone.ondragleave = (e) => {
    if (e.relatedTarget && uploadZone.contains(e.relatedTarget)) return;
    uploadZone.classList.remove('can-upload');
  };
  uploadZone.ondrop = (e) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    uploadZone.classList.remove('can-upload');
    if (!bound) { setHint('请先在上方下拉里选择一个工作区（或在 dsh 中打开项目会话），再拖入文件。', 'warn'); return; }
    if (uploading) { setHint('正在上传，请等待当前批次完成。', 'warn'); return; }
    if (current?.kind !== 'directory') { setHint('请先打开一个目录（点击目录名或项目根目录），再拖入文件。', 'warn'); return; }
    uploadFiles([...e.dataTransfer.files]);
  };
  return {
    toggle,
    dispose() { sequence++; disposeImage(); disposeResize(); toggle.remove(); },
    context(data) {
      if (!setContext(data)) return;
      renderWorkspacePicker();
      if (!aside.hidden) open('.');
    },
    async receive(data) {
      // 内嵌页点了文件但没上报会话（例如 URL 不带 ?session=）：先兜底绑定一个工作区，
      // 这样路径仍然能解析，而不是只弹一句「请先打开会话」。
      setContext(data);
      if (!bound) await primeWorkspace();
      renderWorkspacePicker();
      await open(data.path, Number.isSafeInteger(data.line) && data.line > 0 ? data.line : null);
    },
  };
}
