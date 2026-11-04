# WaveLog Bridge

将 TX-5DR 的电台频率、模式实时同步到 WaveLog 的 Radio Interface（硬件接口），并支持在 WaveLog Bandmap / DX Cluster 中点击 Spot 让电台切频。

基于 BI7ALG 的 WaveLogGate for TX-5DR 2.1.0 改写。

## 功能

- 频率、模式变化时上报 WaveLog（`/index.php/api/radio`），并定时发送心跳，避免 WaveLog 判定电台离线
- Bandmap 点击切频：在本机监听 WaveLog 的 CAT 回调（默认 `127.0.0.1:54321`）
- FT8/FT4 模式下点击 Spot 自动对齐到标准拨号频率（如 14.074 MHz）
- 全局单实例，多操作员不会重复上报或抢占端口
- API URL 自动纠正，失败时指数退避，日志不刷屏

## 配置

1. 在 WaveLog「管理 → API」生成读写 API Key。
2. 插件设置中填写 WaveLog 根地址（如 `https://log.example.com`）、API Key、电台名称。
3. WaveLog「硬件接口」中出现该电台后，编辑并将 CAT URL 设为 `http://127.0.0.1:54321`。

## 注意

- 只切频率，不切模式（TX-5DR 插件接口不提供模式控制）；发射中切频请求会被拒绝。
- 回调请求由浏览器发出：浏览器需与 TX-5DR 在同一台电脑上，或通过 HTTPS 反向代理访问。
- Safari 及 uBlock 等扩展可能拦截 https 页面访问本机地址，建议使用 Chrome / Firefox，并允许"本地网络访问"。
- TX-5DR 运行在 Linux 服务器时，可在服务器 nginx 中增加 `location /wavelog-cat/ { proxy_pass http://127.0.0.1:54321/; }`，CAT URL 设为 `https://<服务器>:8443/wavelog-cat`。

## English

Pushes TX-5DR frequency/mode to the WaveLog Radio Interface API and serves WaveLog's CAT callback so a Bandmap click tunes the radio. Set the WaveLog base URL, API key and radio name, then set the radio's CAT URL in WaveLog to `http://127.0.0.1:54321`.
