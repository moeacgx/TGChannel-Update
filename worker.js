// Telegram channel update monitor for Cloudflare Workers
// 监听多个频道/群的新消息，推送到指定通知频道，并支持全局/单频道暂停（按钮切换）。
// 环境变量：
// - BOT_TOKEN: Telegram Bot Token
// - TARGET_CHAT_ID: 目标通知频道/群 ID（例如 -1001234567890）
// - ADMIN_IDS: 允许使用管理命令的用户 ID，逗号分隔
// - STATE_KV: 绑定的 KV 命名空间（wrangler.toml 中配置 binding = "STATE_KV"）

const STATE_KEY = "state:v1";

export default {
  /**
   * Cloudflare Worker 入口
   */
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

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
  if (status === "administrator" || status === "member") {
    ensureChannel(state, chat);
    await notifyAdmins(env, adminIds, `${chat.title ?? chat.username ?? chat.id} 已加入监听列表`);
  } else if (status === "left" || status === "kicked") {
    delete state.channels[chat.id];
    await notifyAdmins(env, adminIds, `${chat.title ?? chat.username ?? chat.id} 已移除监听列表`);
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
