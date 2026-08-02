export function buildFeishuOAuthTokenPayload({
  appId,
  appSecret,
  code,
  redirectUri = '',
}) {
  const payload = {
    grant_type: 'authorization_code',
    client_id: String(appId),
    client_secret: String(appSecret),
    code: String(code),
  };
  const normalizedRedirectUri = String(redirectUri || '').trim();
  if (normalizedRedirectUri) {
    payload.redirect_uri = normalizedRedirectUri;
  }
  return payload;
}
