# `dsh21.mjs` — 低带宽下向远端 dsh 发指令

在一条 25–30 KB/s、握手要几秒、还会随机丢连的 VPN（`dgx21.tun`）上，**dsh web UI 是
不通的**：UI 可用之前必须先拉完 **3 501 190 B（3.34 MB）**（46 个插件 bundle + root），
而这些 bundle 是**并发**拉的，任何一个超时，插件加载器整体报错、UI 直接死：
`Failed to load plugins`。而同一台机器上 `dsh --profile headless "任务"` 跑完一条指令
只要 **9.6 KB**（复用连接后 **0.7 KB**）——差 364× / 4 917×。

完整背景、实测数据、劣化测试与优化清单见
[`docs/dgx21-lowbandwidth-channel.md`](../docs/dgx21-lowbandwidth-channel.md)。

## 用法

```sh
scripts/dsh21-deploy.sh dgx21.tun                       # 装环境（幂等，173 字节，不下载任何东西）
node scripts/dsh21.mjs "你的指令"                       # 发一条指令
node scripts/dsh21.mjs --probe                          # 只探链路（不调模型）
node scripts/dsh21.mjs --cwd /home/bot/data "跑测试"     # 指定远端工作目录（不存在则直接失败，不会偷偷在别处跑）
node scripts/dsh21.mjs --measure "print the hostname"   # 报线上字节
node scripts/dsh21.mjs --require-verified "推最终结果"    # 只重试「确定没开始」的失败

# 长任务 / 链路不稳：脱离连接跑，回来再取（连接断了任务也不死）
id=$(node scripts/dsh21.mjs --detach "分析这批样本并写报告")
node scripts/dsh21.mjs --status  $id      # 一次往返：running / done(rc)
node scripts/dsh21.mjs --collect $id      # 等到跑完，打印答案
```

`--help` 有全部开关。

## 五个关键设计

1. **复用连接**：`ControlMaster` + `ControlPersist=600`。握手 ~9 KB 且慢，只付一次。
2. **压缩加在 master 上**：真正搬数据的是 master，`-C` 写在别处无效（踩过的坑）。
3. **重试安全**：一次性指令不幂等，重跑＝执行两遍。远端在启动 dsh 前写标记文件，
   重试前先读它：标记不存在才允许重试。**不能**用 ssh 的 stderr 判断——开 mux 后它
   什么都不打印。
4. **一次尝试必须有界**：不能只等 `close`（被 fork 出去的 master 会攥着管道不放），
   否则「超时」本身会吊死。
5. **长任务脱离连接**：同步路径把连接从头挂到尾，断线时 sshd 的 SIGHUP 会把 dsh 一起杀掉。
   `--detach` 把任务写成 runner 脚本、用 `setsid` 起、stdio 指向文件，ssh 立刻返回。

## 配套工具

```sh
# 量具：把 SSH 塞进一个会计数的 TCP 代理，还能把链路做坏
node scripts/soak/net-shim.mjs --stdio --target 10.8.0.21:22 --stats /tmp/s.json

# 通宵稳定性测试（默认 16 轮 × 30 分钟）
node scripts/soak/soak.mjs
node scripts/soak/soak.mjs --report

# 只读取证：证明这一夜没有下载任何包/缓存（开工前拍基线，收工后比对）
node scripts/soak/nodownload-check.mjs --host dgx21.tun --snapshot /tmp/base.json
node scripts/soak/nodownload-check.mjs --host dgx21.tun --compare  /tmp/base.json

# 复现核心数字：web 首屏多重、gzip 后能省多少（在远端 loopback 上量，不占链路）
node scripts/soak/bundle-weight.mjs --host dgx21.tun

# 模拟坏链路：kbyte=千字节 / kbps=千比特，差 8 倍，别搞混
node scripts/dsh21.mjs --shim-rate-kbyte 4 "print the hostname"
```

早上看结果用 `node scripts/soak/soak.mjs --report`（加 `--markdown` 直接出可贴文档的表格）。

## 测试

```sh
npm test                                                          # 全量
node --test tests/dsh21-classify.test.js tests/nodownload-check.test.js \
             tests/soak-report.test.js  tests/net-shim-rate.test.js   # 只跑本工具的
```
