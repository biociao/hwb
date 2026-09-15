// —— dsh 主题同步（写 settings.yaml）——
//
// 目标：hwb 切「白天/黑夜/跟随系统」时，把这个偏好**单向下发**给每个已连接的 dsh 实例，
// 使 dsh 自己的主题跟着变，并在 hwb 重启后依然一致。
//
// 为什么写文件而不是走 dsh 的 RPC：dsh 的 settings 走 Gateway 的 `settings/mutate`，
// 需要构造 typert 信封且不同版本形态不一；而 `settings.yaml` 是 dsh 的**文件型 settings provider**
// （`@deepseek-ai/dsh-settings-file`），它自带 chokidar watcher（`awaitWriteFinish` 去抖），
// 文件一改就热重载 → 客户端主题即时切换，且持久化天然成立。契约更稳定：只是「一个 namespace 一节」。
//
// 关键约束（实测自 dsh 的 persistSection 实现）：
//   · 文档根必须是 **map of namespace sections**（`ui-theme:` 一节），非 map 根会被判非法；
//   · dsh 自己写盘时用 `withFileLock` + 原子替换，mode 0600；
//   · 我们**只能改自己这一节**，其它 namespace（llm 的 apiKey、locale、model 白名单…）必须逐字节保住 ——
//     这是「手写 YAML 编辑器」而不是「YAML 解析后重序列化」的原因：重序列化会把用户的注释、
//     引号风格、缩进全部冲掉，而这份文件里有 API key 之类不该被我们碰的内容。

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** dsh 主题偏好只接受这三个值（见 dsh-client-ui-theme 的 THEME_PREFERENCES）。 */
export const THEME_PREFERENCES = ['light', 'dark', 'system'];
/** dsh 主题偏好的 settings namespace 与字段名（dsh 侧的事实来源）。 */
export const THEME_NAMESPACE = 'ui-theme';
export const THEME_FIELD = 'preference';

export function isThemePreference(value) {
  return THEME_PREFERENCES.includes(value);
}

/** dsh home 下的 settings 文件路径（dsh 默认 `settings.yaml`）。 */
export function themeSettingsPath(homePath) {
  return join(homePath, 'settings.yaml');
}

// —— 最小 YAML 顶层-section 读写 ——
//
// 只处理「顶层键 + 缩进块」这一层结构，因为这是 dsh settings.yaml 的**唯一**形态
// （`settings-file` 强制根为 map of sections）。块内容原样保留，不做任何解析/重排。

/**
 * 读出顶层某节的文本块（含其下所有缩进行），以及它在原文里的行区间。
 * @param {string} text 整份文档
 * @param {string} key 顶层键名
 * @returns {{ found: boolean, body: string, start: number, end: number }}
 *   start/end 是**行下标**区间（[start, end)），found=false 时两者相等表示插入点。
 */
export function readSection(text, key) {
  // 按 \r?\n 切分：CRLF 文件里每行末尾的 \r 若留着，`/^\s/` 之类的判据仍能工作，
  // 但拼回去时会产生混行。统一在这里去掉，交由 applyThemePreference 按原文风格重建。
  const lines = String(text).split(/\r?\n/);
  // 顶层键的判据：行首无缩进、形如 `key:`（可选行内值）。带引号的键一并认（YAML 允许 `'ui-theme':`）。
  const bare = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
  const quoted = new RegExp(`^(['"])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1\\s*:`);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s/.test(line) || line.trimStart().startsWith('#')) continue;
    if (!bare.test(line) && !quoted.test(line)) continue;
    let end = i + 1;
    // 该节的结束 = 下一个非空、非注释、**无缩进**的行（下一个顶层键）。
    while (end < lines.length) {
      const next = lines[end];
      if (next.trim() === '') { end += 1; continue; }
      if (/^\s/.test(next)) { end += 1; continue; }
      break;
    }
    // 回退掉尾部空行：它们是节与节之间的分隔，留在节内会让「替换」多吃掉一段空白。
    while (end > i + 1 && lines[end - 1].trim() === '') end -= 1;
    return { found: true, body: lines.slice(i, end).join('\n'), start: i, end };
  }
  return { found: false, body: '', start: lines.length, end: lines.length };
}

/**
 * 读某节下的一级子字段值（`  preference: light`）。
 * 只用于**判断是否需要写盘**，不承担通用 YAML 语义。
 */
export function readSectionField(body, field) {
  const re = new RegExp(`^\\s+${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(.*)$`);
  for (const line of body.split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    return unquote(m[1].trim());
  }
  return undefined;
}

function unquote(raw) {
  const m = /^(['"])(.*)\1$/.exec(raw);
  return m ? m[2] : raw;
}

/**
 * 生成/替换 `ui-theme` 一节，**其它内容逐字节不动**。
 * @param {string} text 原文（可为空串 = 文件不存在）
 * @param {string} preference light/dark/system
 * @returns {string} 新文档
 */
export function applyThemePreference(text, preference) {
  if (!isThemePreference(preference)) throw new Error(`invalid theme preference: ${preference}`);
  const src = typeof text === 'string' ? text : '';
  // 保留原文件的换行风格：dsh 在 Windows/某些编辑器手上可能写出 CRLF，
  // 我们插进去的那一行若用 LF，文件就变成混合换行（YAML 仍能解析，但没必要的 diff）。
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  const found = readSection(src, THEME_NAMESPACE);
  if (found.found) {
    // 同一节里可能还有 dsh 自己写的其它字段（fontSize 等）：保留它们，只改 preference 那一行。
    const block = lines.slice(found.start, found.end);
    let replaced = false;
    for (let i = 1; i < block.length; i += 1) {
      if (/^\s+preference\s*:/.test(block[i])) {
        block[i] = `  preference: ${preference}`;
        replaced = true;
        break;
      }
    }
    if (!replaced) block.push(`  preference: ${preference}`);
    lines.splice(found.start, found.end - found.start, ...block);
    return lines.join(eol);
  }
  const section = ['ui-theme:', `  preference: ${preference}`].join(eol);
  // 文件不存在（空串）时不要留一个前导空行。
  const head = src.trim() === '' ? '' : (src.endsWith('\n') ? src : `${src}${eol}`);
  return `${head}${section}${eol}`;
}

/**
 * 读一个 dsh home 当前的主题偏好。读不到（文件不存在/无该节）返回 null ——
 * 调用方据此区分「已知是 light」与「不知道」，不要把默认值伪装成事实。
 */
export function readThemePreference(homePath) {
  let text;
  try {
    text = readFileSync(themeSettingsPath(homePath), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const body = readSection(text, THEME_NAMESPACE).body;
  if (!body) return null;
  const value = readSectionField(body, THEME_FIELD);
  return isThemePreference(value) ? value : null;
}

/**
 * 把主题偏好写进一个 dsh home 的 settings.yaml。
 *
 * 原子替换（临时文件 + rename）而不是原地写：dsh 的 chokidar watcher 在 `awaitWriteFinish`
 * 之后热重载这份文件，原地写会让它读到**半截 YAML**——dsh 的处理是「保留上一份好文档并告警」，
 * 于是主题不会变，而且日志里只留一句 warn。rename 是原子的，watcher 只会看到完整内容。
 *
 * 权限跟 dsh 保持一致（文件 0600 / 目录 0700）：这份文件里有 API key。
 *
 * @returns {{ changed: boolean, path: string, preference: string }}
 */
export function writeThemePreference(homePath, preference) {
  if (!isThemePreference(preference)) throw new Error(`invalid theme preference: ${preference}`);
  const file = themeSettingsPath(homePath);
  let before = '';
  try { before = readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const after = applyThemePreference(before, preference);
  if (after === before) return { changed: false, path: file, preference };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.hwb-${process.pid}-${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, after, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* 临时文件可能压根没建起来 */ }
    throw error;
  }
  // 目录/文件已存在时 mkdir/write 的 mode 会被忽略，这里显式收紧一次（不改变内容，失败不致命）。
  try {
    if ((statSync(file).mode & 0o777) !== 0o600) writeFileSync(file, after, { mode: 0o600 });
  } catch { /* 权限收紧是尽力而为 */ }
  return { changed: true, path: file, preference };
}

/** 远程实例的 settings.yaml 路径（远端 home 可能是 `~/.dsh` 这种带 ~ 的写法）。 */
export function remoteThemeSettingsPath(remoteHome) {
  const home = (remoteHome && String(remoteHome).trim()) || '~/.dsh';
  return join(home, 'settings.yaml');
}

/**
 * 生成远程下发的 shell 片段：在远端 home 的 settings.yaml 里写入 ui-theme.preference。
 *
 * 为什么不用 `sed -i`：远端要兼容 GNU/BSD 两套 sed，且 `sed` 原地改写**不是原子的** ——
 * 远端 dsh 同样有 watcher。这里仍然走「临时文件 + mv」的原子替换，并且**保留其它 section**：
 * 用一个 awk 片段把 `ui-theme` 一节整体替换掉，其余行原样输出。
 */
export function remoteThemeCommand(remoteHome, preference) {
  if (!isThemePreference(preference)) throw new Error(`invalid theme preference: ${preference}`);
  const file = remoteThemeSettingsPath(remoteHome);
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  // awk 里维护「当前是否在 ui-theme 节内」；遇到下一个顶层键就收尾。节尾补一行 preference。
  const awk = [
    `awk -v pref=${q(preference)} '`,
    'BEGIN { insec=0; done=0 }',
    // 顶层键（无缩进、非空、非注释）
    '/^[^ \\t]/ && $0 !~ /^[ \\t]*$/ {',
    '  if (insec && !done) { print "  preference: " pref; done=1 }',
    '  insec = ($0 ~ /^["]?ui-theme["]?[ \\t]*:/) ? 1 : 0',
    '}',
    'insec && /^[ \\t]+preference[ \\t]*:/ { next }',
    '{ print }',
    'END { if (insec && !done) print "  preference: " pref }',
    `'`,
  ].join('\n');
  // 分号而不是 && 串起来：shell 里 `a || b && c` 的结合是 `a || (b && c)`，
  // 于是「节已存在」（grep 成功）时后半段整个被短路掉 —— awk 一次都不跑，主题写不进去。
  // 这里用 `;` 显式分隔，且最终以 `mv` 的退出码为准。
  return [
    `f=${q(file)}`,
    'mkdir -p "$(dirname "$f")"',
    // 若无该节则先追加一节（`|| ` 只作用于这一条 `printf`）。
    `grep -qE ${q('^["]?ui-theme["]?[ \\t]*:')} "$f" 2>/dev/null || printf 'ui-theme:\\n  preference: ${preference}\\n' >> "$f"`,
    `tmp="$f.hwb-theme.$$"`,
    `${awk} "$f" > "$tmp"`,
    `chmod 600 "$tmp"`,
    `mv "$tmp" "$f"`,
  ].join('; ');
}
