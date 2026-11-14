export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

export function safeColor(value) {
  return /^#[0-9a-fA-F]{6}$/.test(String(value || '')) ? value : '#2563eb';
}
