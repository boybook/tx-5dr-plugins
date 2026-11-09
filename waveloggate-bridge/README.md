# WaveLog Bridge for TX-5DR

基于 BI7ALG/tx5dr-waveloggate-plugin 2.1.0 修改。

- 频率、模式实时同步到 WaveLog，并定时发送心跳
- WaveLog Bandmap 点击切频（本地 HTTP 回调，默认 127.0.0.1:54321）
- FT8/FT4 模式下自动对齐标准拨号频率
- 全局单实例，多操作员不会重复上报
