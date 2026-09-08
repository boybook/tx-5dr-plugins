function getUrlToken(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  const token = params.get('auth_token');
  return token && token.trim() ? token.trim() : null;
}

export async function fetchCurrentUserLabel(): Promise<string | null> {
  const token = getUrlToken();
  const response = await fetch('/api/auth/me', {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    credentials: 'same-origin',
  });

  if (!response.ok) {
    return null;
  }

  const json = await response.json() as { label?: unknown };
  if (typeof json.label !== 'string') {
    return null;
  }

  return json.label;
}
