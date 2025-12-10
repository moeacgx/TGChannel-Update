# Telegram 频道更新通知 Cloudflare Worker

该 Worker 监听 Telegram Webhook，监控 Bot 被邀请为管理员的频道/群的新消息，并将“频道已更新”通知推送到指定的目标频道或群。支持全局暂停、单频道暂停（按钮切换），仅限管理员 ID 操作。

## 目录
- `worker.js`：主入口
- `wrangler.toml.example`：配置示例

## 环境变量
- `BOT_TOKEN`：Bot Token
- `TARGET_CHAT_ID`：通知发送到的频道/群 ID（负号开头的长整型）
- `ADMIN_IDS`：管理员用户 ID，逗号分隔
- `STATE_KV`：KV 命名空间绑定名（在 `wrangler.toml` 中设置）

## 部署步骤
1. 创建 KV：`wrangler kv:namespace create STATE_KV`
2. 复制并填写 `wrangler.toml.example` 为 `wrangler.toml`，填入 KV id、Bot 配置。
3. 部署：`wrangler deploy`
4. 设置 Telegram Webhook（替换 `<WORKER_URL>` 与 `<BOT_TOKEN>`）：  
   ```bash
   curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d "{\"url\": \"https://<WORKER_URL>/\"}"
   ```

## 使用说明
- 将 Bot 邀请到源频道或群，并设为管理员；收到 `my_chat_member` 更新后即加入监听列表。
- 频道/群有新消息时，会向 `TARGET_CHAT_ID` 发送：`<频道名> 💌已更新`。
- 管理命令（仅限 `ADMIN_IDS`）：发送任意消息给 Bot，返回带按钮的面板，可点击：
  - `暂停/恢复全部`
  - `暂停/恢复 <频道>`（逐个频道）

## 备注
- 状态存储在 KV 中，键名 `state:v1`。
- 未启用的频道自动被忽略；被移除管理员/踢出后自动清理。
