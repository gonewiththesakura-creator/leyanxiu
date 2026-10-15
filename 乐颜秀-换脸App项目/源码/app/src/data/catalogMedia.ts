// Native packages load a catalog from the API host. Newly uploaded assets do
// not exist inside the installed APK, so resolve controlled paths there too.
export function catalogMediaUrl(value: string | undefined, apiBase: string): string | undefined {
  if (!value || !apiBase) return value;
  if (!/^\/(templates|effects|banners|plays|avatars)\//.test(value) || /[\\%?#]/.test(value) || value.includes("..")) return value;
  return new URL(value, apiBase).href;
}
