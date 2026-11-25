(() => {
  const margin = 8, gap = 6;
  let opened;
  function layout(rect, width, height, contentHeight) {
    const menuWidth = Math.max(0, Math.min(260, width - margin * 2));
    const below = Math.max(0, height - rect.bottom - gap - margin);
    const above = Math.max(0, rect.top - gap - margin);
    const up = contentHeight > below && above > below;
    const maxHeight = Math.min(Math.max(above, below), height - margin * 2);
    const usedHeight = Math.min(contentHeight, maxHeight);
    return { left: Math.max(margin, Math.min(rect.right - menuWidth, width - menuWidth - margin)),
      top: Math.max(margin, Math.min(up ? rect.top - gap - usedHeight : rect.bottom + gap, height - usedHeight - margin)),
      width: menuWidth, maxHeight: Math.max(0, maxHeight), up };
  }
  function close(restoreFocus = false) {
    if (!opened) return;
    const { menu, button, parent, next } = opened;
    opened = undefined;
    menu.classList.remove('visible');
    button.setAttribute('aria-expanded', 'false');
    if (parent.isConnected) parent.insertBefore(menu, next?.parentNode === parent ? next : null);
    else menu.remove();
    if (restoreFocus && button.isConnected) button.focus();
  }
  function position() {
    if (!opened) return;
    const { menu, button } = opened;
    if (!button.isConnected) return close();
    const rect = button.getBoundingClientRect();
    const width = document.documentElement.clientWidth, height = window.innerHeight;
    if (rect.bottom < 0 || rect.top > height) return close();
    menu.style.width = Math.max(0, Math.min(260, width - margin * 2)) + 'px';
    const p = layout(rect, width, height, menu.scrollHeight);
    Object.assign(menu.style, { left: p.left + 'px', right: 'auto', top: p.top + 'px',
      maxHeight: p.maxHeight + 'px' });
  }
  window.adminActionMenu = { layout, close, toggle(event, menu) {
    event.stopPropagation();
    const button = event.currentTarget;
    const same = opened?.menu === menu;
    close();
    if (!menu || same) return;
    opened = { menu, button, parent: menu.parentNode, next: menu.nextSibling };
    document.body.append(menu); // Escape table/panel overflow and stacking contexts.
    menu.classList.add('visible');
    button.setAttribute('aria-expanded', 'true');
    position();
    menu.querySelector('button:not(:disabled)')?.focus();
  } };
  document.addEventListener('keydown', event => {
    if (!opened) return;
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    const items = [...opened.menu.querySelectorAll('button:not(:disabled)')];
    const index = items.indexOf(document.activeElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(event.key) && items.length) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
        : (index + (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey) ? -1 : 1) + items.length) % items.length;
      items[next].focus();
    }
  });
  window.addEventListener('resize', position);
  window.addEventListener('scroll', event => {
    if (opened && !opened.menu.contains(event.target)) position();
  }, true);
})();
