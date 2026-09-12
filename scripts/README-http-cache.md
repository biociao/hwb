# 打开 dsh 页面/实例慢 → 用 HTTP 本地缓存解决

## 先说结论(已从源码确认的根因)

dsh web 是**客户端-服务器 SPA**:
- 浏览器加载 `@deepseek-ai/dsh-web-frontend/dist` 的**静态资源**(约 4.5MB、86 个文件,
  含 `index-*.js`、`vendor-*.js`、以及按语言懒加载的 `langs/*`——其中 `cpp` 单个就 624KB)。
- 这些资源由 `@deepseek-ai/dsh-host-frontend-static` 的 `serveStatic` 返回,但**它只设置了
  `Content-Type`,没写 `Cache-Control` / `ETag` / `Last-Modified`**:

  ```js
  res.writeHead(200, { "content-type": type });
  res.end(body);
  ```

→ **结果: 浏览器每次打开页面都重新下载这 4.5MB**(HTTP 缓存从未生效)。远程网络慢时,
这一步就被放大成「打开页面/实例卡很久」。前端也没有 Service Worker 做兜底缓存。

## 先定位: 到底是「静态资源」还是「项目数据拉取」在慢

浏览器开发者工具 → Network → 重新打开页面/实例,看哪行很慢:
- **`/assets/*` 且每条都全量下载、无 `Cache-Control`** + 对应 `4.5M` 总传输 → 就是本问题,
  用下面的缓存方案,收益最直接。
- 慢的是 **`/api/*` 的 RPC 返回**(如 DCS 计划/结果/交付面板) → 那是服务器端/云 API 在慢,
  不是静态资源缓存能解决的,需另查(见文末「若是 /api 慢」)。

## 方案 A(推荐, 升级无损): 反代加缓存头

在 dsh web(:3080)前架一个缓存反向代理,给 `/assets/*` 发「不可变强缓存 1 年」,
给入口发 `no-cache`,并开 brotli/zstd/gzip。**不碰 dsh 代码,升级 dsh 也不会丢。**

两个现成文件,任选其一:
- [`dsh-http-cache.Caddyfile`](dsh-http-cache.Caddyfile) — 最简单(推荐, 自动处理 websocket+压缩)
- [`dsh-http-cache.nginx.conf`](dsh-http-cache.nginx.conf) — 已装 nginx 时用

```bash
# 以 Caddy 为例(keep dsh web on :3080):
#   nohup dsh web >/dev/null 2>&1 &
cp dsh-http-cache.Caddyfile /etc/caddy/Caddyfile
systemctl enable --now caddy
# 浏览器改访问  http://<服务器IP>:3081
```

**nginx 版注意**: 该文件里包含一个 `map` 块(用请求里有没有 `Upgrade` 来按需决定
`Connection` 头),`map` 是 **http 上下文**指令。`conf.d/*.conf` 通常被 include 在 `http{}` 内,
所以整体拷进去可以;若你的 nginx.conf 把 conf.d 放在别处而报 `"map" directive is not allowed here`,
就把那个 `map` 块挪到 `nginx.conf` 的 `http{}` 里。改了 `map`/`server` 之后 `nginx -t` 验一下再 reload。

> 资源文件名为 hash 后缀(内容寻址、不可变),所以强缓存安全;
> 浏览器「本地命中缓存」后,再次打开本页/本实例直接从浏览器缓读取,不用再连服务器。

## 方案 B(快速, 不加进程): 直接给 vendored 的 serveStatic 加缓存头

若不方便装反代,可给 `node_modules/@deepseek-ai/dsh-host-frontend-static/lib/index.js` 的
`serveStatic` 加一行逻辑(以 `/assets/` 前缀区分):

```js
res.writeHead(200, {
  "content-type": type,
  "cache-control": pathname.startsWith("/assets/")
    ? "public, max-age=31536000, immutable"   // hash 资源: 强缓存 1 年
    : "no-cache"                              // 入口: 走校验
});
res.end(body);
```

- 注意: 改动在 node_modules, **升级 dsh 后会被覆盖**, 需重打。
- 只影响静态资源, `/api/*` 与 WebSocket(`/api/events.mux`)路由不受影响。

## 预期与注意

- **第一次仍会全量下载**(填充缓存);之后再次打开同页/实例从浏览器缓存秒开。
- 若浏览器本身就在服务器本机(localhost),静态资源下载本来就快,慢的更可能来自
  `/api/*` 服务器端 → 看上面「先定位」,别在缓存上白费功夫。
- 反代只会让前端更快;**不改变**「打开实例时服务器为组装项目数据而做的计算/云调用」,
  那部分若慢,是架构层面的,需要另外定位。

## 若是 `/api/*` 慢(另查方向)

打开实例时浏览器会 `WebSocket /api/events.mux` + `/api/*` RPC 拉取项目/会话/或 DCS
计划-模块-结果-交付面板数据。若主因在这:
- 服务器端在拼大项目状态或调用 DCS 云 API(BGI-时空)→ 网速/云 API 延迟是主因;
- 这种缓存要么做服务端响应缓存(如把 dcs-projects.json / 结果按 project+版本缓存并失效),
  要么减少单次返回体量(分页/惰性加载)。
- 可先 `nc -vz <dsh服务> 3080` 看建连,再用 `--cpu-prof` 看服务端耗时分布。
