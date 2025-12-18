// Telegram channel update monitor for Cloudflare Workers
// 监听多个频道/群的新消息，推送到指定通知频道，并支持全局/单频道暂停（按钮切换）。
// 环境变量：
// - BOT_TOKEN: Telegram Bot Token
// - TARGET_CHAT_ID: 目标通知频道/群 ID（例如 -1001234567890）
// - ADMIN_IDS: 允许使用管理命令的用户 ID，逗号分隔
// - STATE_KV: 绑定的 KV 命名空间（wrangler.toml 中配置 binding = "STATE_KV"）
// - KICK_API_KEY: 外部踢人接口的 API 密钥（用于 /api/kick 端点）

const STATE_KEY = "state:v1";

export default {
  /**
   * Cloudflare Worker 入口
   */
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // 路由分发：/api/kick 为外部踢人接口
    if (path === "/api/kick") {
      return await handleKickRequest(request, env);
    }

    // 默认：Telegram Webhook 处理
    const update = await request.json();
    const adminIds = parseAdminIds(env.ADMIN_IDS);
    const state = await loadState(env);

    // 按类型分发
    if (update.my_chat_member) {
      await handleMyChatMember(update.my_chat_member, state, env, adminIds);
    } else if (update.callback_query) {
      if (!isAdmin(update.callback_query.from, adminIds)) {
        await answerCallback(env, update.callback_query.id, "无权操作");
        return jsonOk();
      }
      await handleCallbackQuery(update.callback_query, state, env);
    } else if (update.message || update.channel_post) {
      await handleMessage(update.message ?? update.channel_post, state, env, adminIds);
    }

    // 持久化状态
    await saveState(state, env);
    return jsonOk();
  },
};

/**
 * 处理外部踢人请求
 * POST /api/kick
 * Header: X-API-Key: <KICK_API_KEY>
 * Body: { "user_id": 123456789 }
 */
async function handleKickRequest(request, env) {
  // 验证 API Key
  const apiKey = request.headers.get("X-API-Key");
  if (!env.KICK_API_KEY || apiKey !== env.KICK_API_KEY) {
    return jsonError("Unauthorized", 401);
  }

  // 解析请求体
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }

  const userId = body.user_id;
  if (!userId) {
    return jsonError("Missing user_id", 400);
  }

  // 加载状态，获取所有监听的频道
  const state = await loadState(env);
  const channelIds = Object.keys(state.channels);

  if (channelIds.length === 0) {
    return jsonResult({ success: true, message: "No channels to kick from", results: [] });
  }

  // 遍历所有频道执行踢人
  const results = await Promise.all(
    channelIds.map(async (chatId) => {
      const channel = state.channels[chatId];
      const result = await kickUserFromChat(env, chatId, userId);
      return {
        chat_id: chatId,
        title: channel.title,
        success: result.ok,
        error: result.ok ? null : result.description,
      };
    })
  );

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.length - successCount;

  return jsonResult({
    success: true,
    message: `Kicked user ${userId} from ${successCount}/${results.length} channels`,
    summary: { total: results.length, success: successCount, failed: failCount },
    results,
  });
}

/**
 * 从指定频道/群踢出用户
 */
async function kickUserFromChat(env, chatId, userId) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/banChatMember`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      user_id: userId,
      revoke_messages: false, // 不删除历史消息
    }),
  });
  return await res.json();
}

function jsonError(message, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonResult(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function parseAdminIds(raw) {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s));
}

function isAdmin(from, adminIds) {
  if (!from) return false;
  return adminIds.includes(Number(from.id));
}

async function handleMyChatMember(event, state, env, adminIds) {
  const { chat, new_chat_member } = event;
  if (!chat || !new_chat_member) return;
  // 不把通知群/频道加入监听列表
  if (env.TARGET_CHAT_ID && Number(chat.id) === Number(env.TARGET_CHAT_ID)) return;
  const status = new_chat_member.status;
  const chatName = chat.title ?? chat.username ?? chat.id;
  const alreadyExists = !!state.channels[chat.id];

  if (status === "administrator" || status === "member") {
    // 只有新加入时才通知，避免重复通知
    if (!alreadyExists) {
      ensureChannel(state, chat);
      await notifyAdmins(env, adminIds, `${chatName} 已加入监听列表`);
    } else {
      // 已存在，只更新标题（如果变了）
      ensureChannel(state, chat);
    }
  } else if (status === "left" || status === "kicked") {
    // 只有确实存在时才删除并通知
    if (alreadyExists) {
      delete state.channels[chat.id];
      await notifyAdmins(env, adminIds, `${chatName} 已移除监听列表`);
    }
  }
}

async function handleMessage(message, state, env, adminIds) {
  if (!message || !message.chat) return;
  const chat = message.chat;

  // 私聊管理员：返回管理面板
  if (chat.type === "private" && isAdmin(message.from, adminIds)) {
    const summary = renderStatus(state);
    await sendTelegram(env, "sendMessage", {
      chat_id: chat.id,
      text: summary,
      reply_markup: buildKeyboard(state),
      parse_mode: "Markdown",
    });
    return;
  }

  // 只处理群组/频道/超级群
  const allowedTypes = ["channel", "supergroup", "group"];
  if (!allowedTypes.includes(chat.type)) return;
  // 避免对通知群自身重复触发
  if (env.TARGET_CHAT_ID && Number(chat.id) === Number(env.TARGET_CHAT_ID)) return;

  // 记录频道
  const channel = ensureChannel(state, chat);

  // 暂停逻辑
  if (state.globalPaused || channel.paused) return;

  // 相册去重：同一 media_group_id 只通知一次（10 分钟窗口）
  const mediaGroupId = message.media_group_id;
  if (mediaGroupId) {
    const now = Date.now();
    if (
      channel.lastMediaGroupId === mediaGroupId &&
      now - (channel.lastMediaGroupTs ?? 0) < 10 * 60 * 1000
    ) {
      return;
    }
    channel.lastMediaGroupId = mediaGroupId;
    channel.lastMediaGroupTs = now;
  }

  const title = chat.title ?? chat.username ?? `${chat.id}`;
  const text = `${title} 💌已更新`;
  await sendTelegram(env, "sendMessage", {
    chat_id: env.TARGET_CHAT_ID,
    text,
    disable_notification: false,
  });
}

async function handleCallbackQuery(callback, state, env) {
  const data = callback.data ?? "";
  if (data === "toggle:global") {
    state.globalPaused = !state.globalPaused;
    await answerCallback(env, callback.id, state.globalPaused ? "已暂停全部" : "已恢复全部");
    await updateManageMessage(callback, state, env);
    return;
  }

  if (data.startsWith("toggle:")) {
    const channelId = Number(data.split(":")[1]);
    const channel = state.channels[channelId];
    if (!channel) {
      await answerCallback(env, callback.id, "频道不存在");
      return;
    }
    channel.paused = !channel.paused;
    await answerCallback(env, callback.id, channel.paused ? "已暂停该频道" : "已恢复该频道");
    await updateManageMessage(callback, state, env);
  }
}

async function updateManageMessage(callback, state, env) {
  // 将当前状态刷新到按钮
  const replyMarkup = buildKeyboard(state);
  const chatId = callback.message?.chat?.id;
  const messageId = callback.message?.message_id;
  if (!chatId || !messageId) return;
  await sendTelegram(env, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  });
}

function ensureChannel(state, chat) {
  if (!state.channels[chat.id]) {
    state.channels[chat.id] = {
      title: chat.title ?? chat.username ?? `${chat.id}`,
      paused: false,
      lastMediaGroupId: null,
      lastMediaGroupTs: 0,
    };
  } else if (chat.title && state.channels[chat.id].title !== chat.title) {
    state.channels[chat.id].title = chat.title;
  }
  return state.channels[chat.id];
}

async function loadState(env) {
  const raw = await env.STATE_KV.get(STATE_KEY);
  if (!raw) {
    return { globalPaused: false, channels: {} };
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { globalPaused: false, channels: {} };
  }
}

async function saveState(state, env) {
  await env.STATE_KV.put(STATE_KEY, JSON.stringify(state));
}

async function answerCallback(env, callbackId, text) {
  await sendTelegram(env, "answerCallbackQuery", {
    callback_query_id: callbackId,
    text,
    show_alert: false,
  });
}

async function notify(env, text) {
  if (!env.TARGET_CHAT_ID) return;
  await sendTelegram(env, "sendMessage", { chat_id: env.TARGET_CHAT_ID, text });
}

async function notifyAdmins(env, adminIds, text) {
  if (!adminIds || adminIds.length === 0) return;
  await Promise.all(
    adminIds.map((id) =>
      sendTelegram(env, "sendMessage", {
        chat_id: id,
        text,
      })
    )
  );
}

function buildKeyboard(state) {
  const rows = [];
  rows.push([
    {
      text: state.globalPaused ? "▶️ 恢复全部" : "⏸️ 暂停全部",
      callback_data: "toggle:global",
    },
  ]);

  Object.entries(state.channels).forEach(([id, ch]) => {
    rows.push([
      {
        text: `${ch.paused ? "▶️" : "⏸️"} ${ch.title}`.slice(0, 30),
        callback_data: `toggle:${id}`,
      },
    ]);
  });

  return { inline_keyboard: rows };
}

function renderStatus(state) {
  const lines = [];
  lines.push(`全局状态：${state.globalPaused ? "⏸️ 已暂停" : "▶️ 运行中"}`);
  if (Object.keys(state.channels).length === 0) {
    lines.push("暂无已加入的频道/群。");
  } else {
    lines.push("频道列表：");
    Object.entries(state.channels).forEach(([id, ch]) => {
      lines.push(`- ${ch.paused ? "⏸️" : "▶️"} ${ch.title} (${id})`);
    });
  }
  return lines.join("\n");
}

async function sendTelegram(env, method, payload) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error("Telegram API error", res.status, body);
  }
}

function jsonOk() {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
