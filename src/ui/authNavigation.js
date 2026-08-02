export function buildFeishuReauthorizationUrl(href) {
  const url = new URL(href);
  url.searchParams.set('forceAuth', '1');
  return url.toString();
}

export function reloadForFeishuReauthorization() {
  window.location.replace(buildFeishuReauthorizationUrl(window.location.href));
}
