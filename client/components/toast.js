export function showToast(message, type = 'info', action = null) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const styles = {
    success: 'bg-green-600 text-white',
    error: 'bg-red-600 text-white',
    info: 'bg-gray-900 text-white dark:bg-gray-700'
  };
  const icons = { success: 'check_circle', error: 'error', info: 'info' };

  const el = document.createElement('div');
  el.className = `flex items-start gap-2 px-4 py-3 rounded-lg shadow-lg text-sm max-w-sm ${styles[type] || styles.info}`;
  const icon = document.createElement('span');
  icon.className = 'material-icons-outlined text-lg shrink-0';
  icon.textContent = icons[type] || icons.info;
  const text = document.createElement('span');
  text.className = 'leading-snug break-words';
  text.textContent = message;
  el.append(icon, text);
  if (action?.label) {
    const button = document.createElement('button');
    button.className = 'ml-auto font-semibold underline shrink-0';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      el.remove();
      action.onClick?.();
    });
    el.append(button);
  }
  container.appendChild(el);

  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity 200ms';
    setTimeout(() => el.remove(), 220);
  }, action?.duration || 4000);
}
