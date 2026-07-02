interface AuthMeResponse {
  tokenId: string;
  label: string;
}

function getUrlToken(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const params = new URLSearchParams(window.location.search);
  const token = params.get('auth_token');
  return token && token.trim() ? token.trim() : null;
}

export async function fetchCurrentUserLabel(): Promise<AuthMeResponse | null> {
  const token = getUrlToken();
  const response = await fetch('/api/auth/me', {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    credentials: 'same-origin',
  });

  if (!response.ok) {
    return null;
  }

  const json = await response.json() as Partial<AuthMeResponse>;
  if (typeof json.tokenId !== 'string' || typeof json.label !== 'string') {
    return null;
  }

  return {
    tokenId: json.tokenId,
    label: json.label,
  };
}
