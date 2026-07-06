/** Lowercase, strip ':', '-', and spaces — matches image_server.py's normalize_mac(). */
export function normalizeMac(mac: string): string {
  return mac.toLowerCase().replace(/[:\- ]/g, "");
}
