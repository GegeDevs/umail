export function setAuthLayout() {
  document.getElementById('sidebar')?.classList.add('hidden');
  document.getElementById('sidebar')?.classList.remove('md:flex');
  document.getElementById('mobile-nav')?.classList.add('hidden');
  document.getElementById('global-search-wrap')?.classList.add('hidden');
  document.getElementById('global-search-wrap')?.classList.remove('flex');
  document.getElementById('user-menu-wrap')?.classList.add('hidden');
  document.getElementById('btn-refresh')?.classList.add('hidden');
  document.getElementById('btn-toggle-sidebar')?.classList.add('hidden');
  const main = document.getElementById('main-content');
  if (main) main.className = 'flex-1 overflow-y-auto min-w-0 bg-gray-50 dark:bg-gray-900';
}

export function setAppLayout() {
  document.getElementById('sidebar')?.classList.remove('hidden');
  document.getElementById('sidebar')?.classList.add('md:flex');
  document.getElementById('mobile-nav')?.classList.remove('hidden');
  document.getElementById('global-search-wrap')?.classList.remove('hidden');
  document.getElementById('global-search-wrap')?.classList.add('flex');
  document.getElementById('user-menu-wrap')?.classList.remove('hidden');
  document.getElementById('btn-refresh')?.classList.remove('hidden');
  document.getElementById('btn-toggle-sidebar')?.classList.remove('hidden');
  const main = document.getElementById('main-content');
  if (main) main.className = 'flex-1 overflow-y-auto min-w-0 bg-gray-50 dark:bg-gray-900';
}
