import { readJson } from './feishuClient.js';

export async function sendFeishuInteractiveMessage(token, openId, card) {
  return sendFeishuMessage(token, {
    receiveId: openId,
    receiveIdType: 'open_id',
    msgType: 'interactive',
    content: card,
  });
}

export async function sendFeishuTextMessage(token, openId, text) {
  return sendFeishuMessage(token, {
    receiveId: openId,
    receiveIdType: 'open_id',
    msgType: 'text',
    content: {
      text: String(text || ''),
    },
  });
}

export async function replyFeishuMessage(token, messageId, {
  msgType = 'text',
  content,
  replyInThread = false,
} = {}) {
  const response = await fetch(
    `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        msg_type: msgType,
        content: JSON.stringify(content || {}),
        reply_in_thread: replyInThread,
      }),
    },
  );
  const payload = await readJson(response);
  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.msg || '回复飞书消息失败');
  }
  return payload.data || {};
}

export async function sendFeishuMessage(token, {
  receiveId,
  receiveIdType = 'open_id',
  msgType,
  content,
} = {}) {
  const query = new URLSearchParams({
    receive_id_type: receiveIdType,
  });
  const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?${query}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: msgType,
      content: JSON.stringify(content || {}),
    }),
  });
  const payload = await readJson(response);

  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.msg || '发送飞书通知失败');
  }

  return payload.data || {};
}
