const PAGE_CONTENT = Object.freeze({
  forbidden: {
    eyebrow: '访问受限',
    statusLabel: '网络校验未通过',
    introduction: '开发平台只允许从受信任的内部网络访问。',
    stepsTitle: '请检查以下项目',
    steps: [
      {
        title: '连接公司局域网',
        description: '确认当前设备已接入与开发平台后端相同的办公网络。',
      },
      {
        title: '检查指定 VPN',
        description: '远程办公时，请先连接管理员提供的 VPN 或受信任网络。',
      },
      {
        title: '重新打开应用',
        description: '网络切换完成后重新检测，或从飞书工作台再次进入开发平台。',
      },
    ],
    note: '为保护内部研发数据，公网入口不会代理开发平台业务内容。',
    actionLabel: '重新检测',
    actionHref: '',
  },
  maintenance: {
    eyebrow: '服务状态',
    statusLabel: '正在等待服务恢复',
    introduction: '开发平台暂时停止接收新访问，现有数据不会受到影响。',
    stepsTitle: '当前处理进度',
    steps: [
      {
        title: '服务升级或重启中',
        description: '后台正在完成版本切换和健康检查。',
      },
      {
        title: '无需修改网络设置',
        description: '保持当前页面打开即可等待服务恢复。',
      },
      {
        title: '自动重新检测',
        description: '页面每 5 秒检查一次，服务就绪后可继续进入。',
      },
    ],
    note: '长时间未恢复时，请联系开发平台管理员确认服务状态。',
    actionLabel: '立即检测',
    actionHref: '',
  },
  unavailable: {
    eyebrow: '服务状态',
    statusLabel: '后端健康检查未通过',
    introduction: '公网入口可用，但开发平台当前尚未准备好。',
    stepsTitle: '可能的原因',
    steps: [
      {
        title: '服务正在启动',
        description: '后端进程可能仍在加载配置和连接飞书服务。',
      },
      {
        title: '服务临时关闭',
        description: '管理员可能正在维护设备或排查运行问题。',
      },
      {
        title: '自动重新检测',
        description: '页面每 5 秒检查一次，恢复后可重新进入。',
      },
    ],
    note: '公网服务器仅负责转发入口请求，不保存或处理开发平台业务数据。',
    actionLabel: '立即检测',
    actionHref: '',
  },
  generic: {
    eyebrow: '访问状态',
    statusLabel: '请求未完成',
    introduction: '入口服务未能完成本次请求。',
    stepsTitle: '建议操作',
    steps: [
      {
        title: '重新打开应用',
        description: '关闭当前页面后，从飞书工作台再次进入开发平台。',
      },
      {
        title: '稍后重试',
        description: '短暂的网络波动或服务切换可能会影响本次访问。',
      },
      {
        title: '联系管理员',
        description: '问题持续出现时，请将页面标题和状态码提供给管理员。',
      },
    ],
    note: '请勿在外部渠道发送账号、授权码或其他敏感信息。',
    actionLabel: '返回入口',
    actionHref: '/',
  },
});

const ICONS = Object.freeze({
  forbidden: `<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M20 13c0 5-3.5 7.5-8 9-4.5-1.5-8-4-8-9V5l8-3 8 3v8Z"></path>
<path d="M12 8v4"></path>
<path d="M12 16h.01"></path>
</svg>`,
  maintenance: `<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M12 2v4"></path>
<path d="m16.2 7.8 2.9-2.9"></path>
<path d="M18 12h4"></path>
<path d="m16.2 16.2 2.9 2.9"></path>
<path d="M12 18v4"></path>
<path d="m4.9 19.1 2.9-2.9"></path>
<path d="M2 12h4"></path>
<path d="m4.9 4.9 2.9 2.9"></path>
</svg>`,
  unavailable: `<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M12 6V2"></path>
<path d="M12 22v-4"></path>
<path d="m4.93 4.93 2.83 2.83"></path>
<path d="m16.24 16.24 2.83 2.83"></path>
<path d="M2 12h4"></path>
<path d="M18 12h4"></path>
<path d="m4.93 19.07 2.83-2.83"></path>
<path d="m16.24 7.76 2.83-2.83"></path>
</svg>`,
  generic: `<svg viewBox="0 0 24 24" aria-hidden="true">
<circle cx="12" cy="12" r="10"></circle>
<path d="M12 8v4"></path>
<path d="M12 16h.01"></path>
</svg>`,
  refresh: `<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M21 12a9 9 0 0 1-15.2 6.5L3 16"></path>
<path d="M3 21v-5h5"></path>
<path d="M3 12A9 9 0 0 1 18.2 5.5L21 8"></path>
<path d="M21 3v5h-5"></path>
</svg>`,
});

export function buildStatusPageHtml({
  statusCode,
  title,
  message,
  refresh = false,
  kind = 'generic',
}) {
  const normalizedKind = Object.hasOwn(PAGE_CONTENT, kind) ? kind : 'generic';
  const content = PAGE_CONTENT[normalizedKind];
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const refreshTag = refresh ? '<meta http-equiv="refresh" content="5">' : '';
  const steps = content.steps.map((step, index) => `
<li>
  <span class="step-number">${index + 1}</span>
  <span class="step-content">
    <strong>${escapeHtml(step.title)}</strong>
    <span>${escapeHtml(step.description)}</span>
  </span>
</li>`).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${refreshTag}
<title>${safeTitle}</title>
<style>
:root{color-scheme:light;--accent:#b42318;--accent-soft:#fef3f2;--border:#dfe3e8;--muted:#646a73;--text:#1f2329;--surface:#fff;--page:#f3f5f7}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;font-family:Arial,"Microsoft YaHei",sans-serif;background:var(--page);color:var(--text);letter-spacing:0}
body{display:flex;align-items:center;justify-content:center;padding:28px 20px}
main{width:min(680px,100%);background:var(--surface);border:1px solid var(--border);border-top:4px solid var(--accent);border-radius:8px;box-shadow:0 16px 42px rgba(31,35,41,.08);overflow:hidden}
.header{display:grid;grid-template-columns:64px minmax(0,1fr);gap:18px;padding:30px 32px 24px}
.status-icon{width:56px;height:56px;display:grid;place-items:center;border-radius:50%;background:var(--accent-soft);color:var(--accent)}
.status-icon svg,.retry svg{width:26px;height:26px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.eyebrow{margin:1px 0 7px;color:var(--accent);font-size:13px;font-weight:700}
h1{margin:0;font-size:28px;line-height:1.25;font-weight:700}
.introduction{margin:9px 0 0;color:var(--muted);font-size:15px;line-height:1.7}
.status-strip{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;padding:16px 32px;background:#f8f9fa;border-top:1px solid var(--border);border-bottom:1px solid var(--border)}
.status-copy{min-width:0}
.status-label{display:block;margin-bottom:4px;font-size:14px;font-weight:700}
.status-message{display:block;color:var(--muted);font-size:14px;line-height:1.6;overflow-wrap:anywhere}
.status-code{flex:0 0 auto;color:#8f959e;font-size:13px;font-variant-numeric:tabular-nums}
.content{padding:24px 32px 30px}
h2{margin:0 0 15px;font-size:16px;line-height:1.4}
ol{list-style:none;margin:0;padding:0;display:grid;gap:16px}
li{display:grid;grid-template-columns:30px minmax(0,1fr);gap:12px;align-items:start}
.step-number{width:26px;height:26px;display:grid;place-items:center;border:1px solid #c9cdd4;border-radius:50%;color:#4e5969;font-size:13px;font-weight:700}
.step-content{display:grid;gap:4px;padding-top:2px}
.step-content strong{font-size:14px;line-height:1.4}
.step-content span{color:var(--muted);font-size:14px;line-height:1.55}
.note{margin:22px 0 0;padding-top:18px;border-top:1px solid #ebeef2;color:#7b818a;font-size:13px;line-height:1.6}
.actions{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:22px}
.retry{min-height:40px;display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:0 18px;border-radius:6px;background:#1f2329;color:#fff;text-decoration:none;font-size:14px;font-weight:700}
.retry:focus-visible{outline:3px solid rgba(51,112,255,.28);outline-offset:2px}
.retry svg{width:17px;height:17px}
.product{color:#8f959e;font-size:12px}
main[data-kind="maintenance"],main[data-kind="unavailable"]{--accent:#b25e09;--accent-soft:#fff7e8}
main[data-kind="generic"]{--accent:#3159c7;--accent-soft:#eef3ff}
@media(max-width:560px){
body{align-items:flex-start;padding:16px 12px}
main{margin:auto 0}
.header{grid-template-columns:48px minmax(0,1fr);gap:14px;padding:24px 20px 20px}
.status-icon{width:46px;height:46px}
.status-icon svg{width:23px;height:23px}
h1{font-size:23px}
.status-strip{display:grid;gap:8px;padding:14px 20px}
.content{padding:21px 20px 24px}
.actions{align-items:stretch;flex-direction:column}
.retry{width:100%}
.product{text-align:center}
}
</style>
</head>
<body>
<main data-kind="${normalizedKind}">
  <header class="header">
    <div class="status-icon">${ICONS[normalizedKind]}</div>
    <div>
      <p class="eyebrow">${escapeHtml(content.eyebrow)}</p>
      <h1>${safeTitle}</h1>
      <p class="introduction">${escapeHtml(content.introduction)}</p>
    </div>
  </header>
  <section class="status-strip" aria-label="当前状态">
    <div class="status-copy">
      <span class="status-label">${escapeHtml(content.statusLabel)}</span>
      <span class="status-message">${safeMessage}</span>
    </div>
    <span class="status-code">HTTP ${escapeHtml(statusCode)}</span>
  </section>
  <section class="content">
    <h2>${escapeHtml(content.stepsTitle)}</h2>
    <ol>${steps}
    </ol>
    <p class="note">${escapeHtml(content.note)}</p>
    <div class="actions">
      <a class="retry" href="${escapeHtml(content.actionHref)}">${ICONS.refresh}<span>${escapeHtml(content.actionLabel)}</span></a>
      <span class="product">IGP Development Platform</span>
    </div>
  </section>
</main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
