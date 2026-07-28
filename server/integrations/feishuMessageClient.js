import { readJson } from './feishuClient.js';

export async function sendFeishuInteractiveMessage(token, openId, card) {
  const query = new URLSearchParams({
    receive_id_type: 'open_id',
  });
  const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?${query}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      receive_id: openId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    }),
  });
  const payload = await readJson(response);

  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.msg || '发送飞书通知失败');
  }

  return payload.data || {};
}
