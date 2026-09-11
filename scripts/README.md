# 远程 `dsh web` 冷启动加速 — 本地缓存方案

针对远程服务器 `nohup dsh web &`(web profile, 默认端口 3080)冷启动慢的问题,
用**两层本地缓存**把「读盘 + V8 解析编译」两个最贵的环节缓存下来。

## 原理(为什么要这样缓存)

`dsh web` 是 `node lib/bin.js --profile web`, 单进程 in-process 启动:
把 187 个 `@deepseek-ai/dsh-*` 插件包 / 279MB node_modules 逐个导入 + V8 解析编译,
再挂 HMR + 文件 watcher + 遥测。冷启动主要耗在:
- **磁盘读**: 几百个 JS 文件从存储读进来; 若 node_modules / `~/.dsh` 在
  NFS/网络盘/慢盘上, 这一步被放大 → 用 **vmtouch 预热 OS 页面缓存** 命中内存;
- **解析/编译**: V8 对每个模块重新 parse+compile → 用 **Node 22 内置的
  `NODE_COMPILE_CACHE`** 把编译后的字节码缓存到磁盘, 下次启动直接复用。

> 前提: 你的 Node 版本需 ≥ 22.7 支持 `NODE_COMPILE_CACHE`(实测 v22.21.1 用
> **环境变量单独即可生效**, 不需要 `--experimental-compile-cache` flag)。

## 文件

| 文件 | 用途 | 详述 |
|------|------|------|
| `dsh-web-cached.sh` | 替换 `nohup dsh web &` 的启动包装脚本(缓存 + 关遥测 + vmtouch 预热 + exec dsh) | 本文件 |
| `dsh-web-cached.service` | 可选: systemd 用户服务, 托管 dsh web(开机自启 + 崩溃重启 + 启动前预热) | 本文件 |
| `dsh-remote-web.sh` | 在**本地**一键完成: SSH 到远端拉起 `dsh web`、抓回 token、建隧道、打印可直接打开的 URL | [`README-dsh-remote-web.md`](README-dsh-remote-web.md) |
| `dsh-http-cache.Caddyfile` | 用 Caddy 给远端 dsh web 加一层 HTTP 缓存反代(静态资源强缓存 + 压缩) | [`README-http-cache.md`](README-http-cache.md) |
| `dsh-http-cache.nginx.conf` | 同上, nginx 版本 | [`README-http-cache.md`](README-http-cache.md) |
| `render-check.mjs` | 前端「真浏览器」渲染检查(CDP 驱动 headless Chrome, 不依赖 --dump-dom) | [`README-render-check.md`](README-render-check.md) |

## 快速部署(脚本版, 改动最小)

```bash
# 1) 拷贝到远程服务器
scp scripts/dsh-web-cached.sh  user@server:$HOME/scripts/
ssh user@server 'chmod +x $HOME/scripts/dsh-web-cached.sh'

# 2) 替换原来的启动命令(注意缓存目录会建在 ~/.cache/dsh, 请确认它在本地 SSD)
ssh user@server 'nohup bash $HOME/scripts/dsh-web-cached.sh web >> $HOME/.dsh/web.log 2>&1 &'

# 3) 若想连 ~/.bashrc 都不加、全局对 `dsh` 生效, 也可直接:
#    export NODE_COMPILE_CACHE=$HOME/.cache/dsh/node-compile
```

## 部署(systemd 版, 更托管)

```bash
scp scripts/dsh-web-cached.sh    user@server:$HOME/scripts/
scp scripts/dsh-web-cached.service user@server:$HOME/.config/systemd/user/
ssh user@server 'chmod +x $HOME/scripts/dsh-web-cached.sh'
ssh user@server '
  systemctl --user daemon-reload
  systemctl --user enable --now dsh-web-cached
  loginctl enable-linger "$USER"   # 允许登出后继续运行
  journalctl --user -u dsh-web-cached -f
'
```

## 验证缓存是否生效

```bash
# 1) 确认环境变量已注入(进入 dsh web 进程的 env, 或看 journalctl):
#    对 systemd:  systemctl --user show dsh-web-cached -p Environment

# 2) 首次启动后, 缓存目录应被填充(node 版本+arch 命名空间):
ls -R $HOME/.cache/dsh/node-compile | head

# 3) 对比启动耗时(同一台机冷重启两次):
time node --help >/dev/null                       # 基线参考
time dsh web --help >/dev/null                    # 占位; 真实请量完整 server 就绪时刻
#    或用 systemd:  systemctl --user restart dsh-web-cached 后 journalctl 看就绪时间戳
```

## 预期与注意

- **首次启动不变慢也不变快**: 缓存目录首次是空的, 在启动过程中自动填充;
  收益体现在**下一次重启/重新部署**时(跳过解析编译)。所以本方案对
  「反复重启 dsh」的场景收益最明显。
- **vmtouch 预热对「单次冷启动」也有即时收益**(命中内存而非磁盘)。
  若 node_modules 在 NFS/网络盘上, 这是把「网络读」降为「内存读」的关键。
- **缓存目录放本地 SSD**, 不要放 NFS; 机器内存大且是网络盘时, 可把
  `DSH_CACHE_DIR` 指到 tmpfs(如 `/dev/shm/dsh`)。
- **`DSH_TELEMETRY_DISABLED=1`** 只是省掉启动期遥测提交, 纯开关; 不需要可去掉。
- 若启动慢还来自 **网络调用**(如插件自动更新、连 DCS), 上面缓存解决不了,
  需要另查 —— 用 `--trace-imports` / `--cpu-prof` 定位主因。

## 更进一步的缓存(按需)

- 慢在「模块导入太多文件」→ 用 esbuild 把插件树 prebundle 成少量文件(改动 launcher, 工程量大);
- 机器内存大 → 把整个 dsh 安装 + `~/.dsh/profiles` 放到 tmpfs 常驻内存(一劳永逸, 但重启要重建);
- Node 用户态快照(`v8.startupSnapshot` + `--snapshot-blob`)→ 启动最快, 但需 launcher 配合。
