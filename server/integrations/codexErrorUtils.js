const RECOVERABLE_TRANSPORT_PATTERNS = Object.freeze([
  /stream disconnected before completion/i,
  /error sending request for url/i,
  /connection (?:reset|closed|aborted)/i,
  /unexpected eof/i,
  /incomplete message/i,
  /http2.*(?:stream|connection).*(?:closed|reset|error)/i,
]);

export function isRecoverableCodexTransportError(error) {
  const code = String(error?.code || '').trim();
  if (code === 'codex_transport') {
    return true;
  }
  if (code && code !== 'codex_failed') {
    return false;
  }

  const message = error instanceof Error
    ? error.message
    : String(error?.message || error || '');
  return RECOVERABLE_TRANSPORT_PATTERNS.some((pattern) => pattern.test(message));
}
