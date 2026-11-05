export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomBase64url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** Opaque id such as trip_AbC... (9 random bytes -> 12 characters) */
export function newId(prefix: string, byteLength = 9): string {
  return `${prefix}_${randomBase64url(byteLength)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
