export const ACCOUNT_COLORS = [
  '#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c',
  '#ca8a04', '#16a34a', '#0d9488', '#0891b2', '#4f46e5'
];

export function pickAccountColor(used = []) {
  const taken = new Set(used.map((color) => String(color).toLowerCase()));
  return ACCOUNT_COLORS.find((color) => !taken.has(color)) || ACCOUNT_COLORS[used.length % ACCOUNT_COLORS.length];
}

export function normalizeCardColor(value) {
  const color = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : null;
}
