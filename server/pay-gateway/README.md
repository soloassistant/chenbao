# 晨报 H5 支付网关

零依赖，只要能跑 Node 20+。整个服务只有一个文件 `index.mjs`。

```bash
# 1) 配环境变量（见下表）
export XUNHUPAY_APPID=...
export XUNHUPAY_APPSECRET=...
export PAY_GATEWAY_HMAC_SECRET=...     # 与数据库 app_secrets 里的值逐字符相同
export PAY_NOTIFY_URL=https://<你的域名>/notify
export PAY_RETURN_URL=https://<前端域名>/#/pages/membership/index
export PAY_PUBLIC_BASE=https://<你的域名>
export PAY_LEDGER_FILE=./pay-orders.json

# 2) 起服务
node index.mjs          # 或 npm start

# 3) 自检
curl -s http://127.0.0.1:8080/health
# 期望 {"ok":true,"configured":true,"claimReady":true,"provider":"xunhupay"}
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `PORT` | 否 | 默认 8080 |
| `XUNHUPAY_APPID` | **是** | 聚合支付商户 appid |
| `XUNHUPAY_APPSECRET` | **是** | 聚合支付密钥（**只在服务端**，绝不进前端） |
| `PAY_GATEWAY_HMAC_SECRET` | **是** | 与数据库 `app_secrets.pay_gateway_hmac` 同一个值；不配则 `/order/claim` 返 503 |
| `PAY_NOTIFY_URL` | **是** | 服务商异步回调地址，指向本服务的 `/notify` |
| `PAY_RETURN_URL` | **是** | 用户付完回跳的前端地址（会员页） |
| `PAY_PUBLIC_BASE` | 是 | 本服务对外地址 |
| `PAY_LEDGER_FILE` | **强烈建议** | 订单账本落盘路径。不配则进程重启后签不出凭证（钱收了开不了） |
| `PAY_CORS_ORIGIN` | 建议 | 前端域名；别留 `*` |
| `PAY_API_CREATE` / `PAY_API_QUERY` | 否 | 换服务商时改签名/查单地址 |

## 接口

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | 自检：`configured`（商户参数）/ `claimReady`（HMAC 密钥） |
| POST | `/order/create` | `{planId, ownerId}` → `{orderId, payUrl}`；缺参数 400，未配置 503 |
| GET | `/order/query?orderId=` | `{status: pending\|paid\|closed\|unknown}` |
| GET | `/order/claim?orderId=` | 只对**已付**订单签发凭证；未付 409，缺 HMAC 503 |
| POST | `/notify` | 服务商回调，验签不过 400，通过回 `success` |

## 三条不能动的行为（改了就是安全事故）

1. **未配置就拒绝**：`/order/create` 返 503 而不是编一个假 `payUrl`；
   `/notify` 验签不过返 400，绝不"看起来像成功"就标已付。
2. **金额只认服务端**：前端传 `price` 一律忽略，按 `planId` 查内置价格表。
3. **`/order/claim` 只签已付订单**：未付返 409，宁可让页面显示"待确认"也不签预支凭证。

## 部署约束

- **单实例假设**：账本是本地文件，多实例部署时 A 实例下的单 B 实例查不到。
  要水平扩展需换共享存储（Redis / PG）。
- **必须公网 HTTPS**：聚合支付回调要求；微信 H5 收银台也只能在 https 页跳转。
