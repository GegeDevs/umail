export function initSidebarToggle() {
  const button = document.getElementById('btn-toggle-sidebar');
  const sidebar = document.getElementById('sidebar');
  if (!button || !sidebar) return;

  const key = 'umail.sidebarCollapsed';
  if (localStorage.getItem(key) === '1') sidebar.classList.add('sidebar-collapsed');

  button.addEventListener('click', () => {
    if (window.innerWidth < 768) {
      sidebar.classList.toggle('sidebar-open');
      return;
    }
    sidebar.classList.toggle('sidebar-collapsed');
    localStorage.setItem(key, sidebar.classList.contains('sidebar-collapsed') ? '1' : '0');
  });

  document.addEventListener('click', (event) => {
    if (!sidebar.classList.contains('sidebar-open')) return;
    if (sidebar.contains(event.target) || button.contains(event.target)) return;
    sidebar.classList.remove('sidebar-open');
  });

  window.addEventListener('hashchange', () => sidebar.classList.remove('sidebar-open'));
}
