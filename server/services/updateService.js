export async function fetchUpdateManifest(manifestUrl) {
  const parsedUrl = new URL(manifestUrl);
  if (parsedUrl.protocol !== 'https:') {
    throw new Error('更新日志地址必须使用 HTTPS');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  try {
    const response = await fetch(parsedUrl, {
      headers: {
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`更新日志服务响应异常（${response.status}）`);
    }
    return await response.json();
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('获取更新日志超时');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
