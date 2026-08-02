# IGP Public Entry Gateway

该工程为飞书网页应用提供固定公网入口，但不在公网服务器运行开发平台业务。

请求链路如下：

1. 飞书打开 `http://47.100.74.169/`。
2. 公网 Nginx 通过 SSH 反向隧道把请求转给局域网后端设备上的 Gateway Agent。
3. Agent 检查开发平台健康状态，并比较请求来源公网 IP 与本机出口公网 IP。
4. 同一出口网络且后端连续健康时，普通浏览器返回到
   `http://172.16.20.205:3000/` 的 `302` 重定向。
5. Agent 从飞书 CDN 下载一次 H5 SDK 并在内存中缓存，通过公网入口同源提供给
   飞书客户端，避免客户端 WebView 直接访问 CDN 时受证书检查影响。
6. 飞书客户端先在公网入口调用 `requestAccess`，无响应或失败时回退到
   `requestAuthCode`，再携带一次性授权码跳转到局域网；局域网页面不会在未登记
   的 LAN URL 上调用飞书免登 JSAPI。
7. 非同一网络返回 `403`；升级、后端不可用或隧道断开返回 `503`。

公网服务器只需要 Nginx 和 OpenSSH Server。Agent、健康检查、访问判断和局域网
重定向都在开发平台后端设备上执行。

## 构建与运行

```powershell
npm test
npm run build
```

构建产物位于 `public-entry-gateway/Publish/`，其中包含 Node 运行时以及：

- `StartPublicEntryGateway.bat`
- `StopPublicEntryGateway.bat`

独立运行时，将 `config.example.json` 复制为
`runtime-state/config.json`，并把 SSH 私钥和 `known_hosts` 放入
`runtime-state/ssh/`。托管部署不需要手工准备这些文件；主后端会把发布包同步到
`managed-runtime/public-entry-gateway`，在
`managed-runtime/public-entry-state` 生成并保留密钥、配置和日志，然后独立启动
Agent。

`accessControl.additionalAllowedCidrs` 可增加允许访问的 VPN 网段。默认空列表只允许
与 Agent 当前公网出口 IP 相同的请求。

## 公网中继初始化

`server/install-public-relay.sh` 用于在公网 Linux 服务器创建受限
`igp-entry` 用户、安装目标 Agent 公钥、配置 Nginx，并开放本机防火墙的 80
端口。SSH 授权仅允许监听公网服务器回环地址
`127.0.0.1:18080`，Nginx 不保存业务状态。

安装脚本不能修改云厂商安全组。公网访问超时时，还需要在云控制台为该实例开放
TCP 80 入站规则；可在服务器上抓包确认请求是否到达操作系统。
