# dsh-static-cache

给 **dsh web 前端静态资源**加 HTTP 缓存头,解决「远程打开页面/实例慢」。

## 为什么

dsh web 前端约 4.5MB 静态资源(`index-*.js`、`vendor-*.js`、`langs/*` 按语言懒加载
chunk)由 `@deepseek-ai/dsh-host-frontend-static` 返回,但**它不写 `Cache-Control`/`ETag`/
`Last-Modified`**,所以浏览器每次打开页面都把整包重新从远程服务器下载(还要过 SSH 隧道),
表现就是「打开页面/实例卡很久」。

本插件在 `webServer` 上注册一个 **`/assets/` 前缀路由**,给它加:
- `Cache-Control: public, max-age=31536000, immutable`(文件名带 hash,不可变)
- `ETag` / `Last-Modified` + `If-None-Match` / `If-Modified-Since` → `304`

`/`、`/index.html`、`/favicon.svg`、`/manifest.webmanifest`、`/api/*`、WebSocket
(`/api/events.mux`) **一律不接管**,仍走默认 fallback 与其余命名路由——index 注入和 API 完全不受影响。

## 安装(远程 web profile)

`dsh` 若不在 PATH,用完整路径(远程上面看到是
`/home/bot/.nvm/versions/node/v24.15.0/bin/dsh`);需要 `pnpm` 在 PATH。

```bash
# 1) 把插件目录拷到远程,例如 /home/bot/dsh-plugins/dsh-static-cache
scp -r dsh-static-cache bot@c4g.tun:/home/bot/dsh-plugins/

# 2) 装进 web profile(会自动并入 dsh.profile.bundles)
/home/bot/.nvm/versions/node/v24.15.0/bin/dsh plugin --profile web add link:/home/bot/dsh-plugins/dsh-static-cache

# 3) 重启 dsh web
kill $(pgrep -f 'dsh web')   # 或按你原来的重启方式
nohup /home/bot/.nvm/versions/node/v24.15.0/bin/dsh web >/dev/null 2>&1 &
```

> 插件目录必须能被 bot 用户读到;`link:` 会让 profile 通过符号链接引用它,升级 dsh 不影响。

## 若 dist 自动定位失败

插件默认自动探测前端 dist 目录(多策略:`config.distRoot` →
`require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')` →
扫描 `$HOME/.nvm/versions/node/*/lib/node_modules` 及常用全局根)。
若启动日志报「无法自动定位」,在该插件行的 `config` 里显式给 `distRoot`:

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml 里 dsh-static-cache 那行加:
- insert:
    - id: dsh-static-cache
      name: dsh-static-cache
      config:
        distRoot: /home/bot/.nvm/versions/node/v24.15.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist
```

## 验证

```bash
# 服务端直接看头(应先返回 immutable)
curl -sI http://127.0.0.1:3080/assets/index-ClqxG24t.js | grep -i cache-control

# 浏览器: DevTools → Network → 重开页面, /assets/* 应显示 "(disk cache)" 且不再全量下载
```

## 开发

```
dsh-static-cache/
  package.json       # 声明 dsh.bundle.patch = ./cordis.patch.yml
  cordis.patch.yml   # 向 web 组合挂载 dsh-static-cache
  lib/index.js       # Cordis 插件: 注册 /assets/ 前缀路由 + 缓存头
```

本地冒烟测试(模拟 cordis ctx + 真实 HTTP 请求,验证 200/304/403/404):
```bash
cd dsh-static-cache && node --check lib/index.js
# 端到端脚本见会话/或自行用下方 apply 触发
```
