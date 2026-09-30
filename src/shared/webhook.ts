/**
 * Webhook 目标识别：前端（表单提示）与后端（投递格式）共用。
 */

/**
 * 飞书 / Lark 自定义机器人地址。
 * 这类地址不接受任意 JSON：必须是飞书消息格式（msg_type + content/card），
 * 且出错时 HTTP 仍返回 200、错误码放在响应体里，所以要按地址识别后单独处理。
 */
export function isFeishuWebhook(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return /^open\.(feishu\.cn|larksuite\.com)$/i.test(u.hostname) && u.pathname.startsWith('/open-apis/bot/v2/hook/');
}
