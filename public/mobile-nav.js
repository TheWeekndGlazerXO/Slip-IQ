// mobile-nav.js — shared bottom nav for all non-home pages
(function() {
  if (window.innerWidth > 768) return;

  var page = window._MOBILE_NAV_ACTIVE || '';

  var nav = document.createElement('div');
  nav.className = 'slipiq-mobile-nav';
  nav.innerHTML = [
    { href: '/home.html',          icon: '⚽', label: 'MATCHES',  key: 'home'    },
    { href: '/leagues.html',       icon: '🏆', label: 'LEAGUES',  key: 'leagues' },
    { href: '/subscriptions.html', icon: '⭐', label: 'PLANS',    key: 'plans'   },
    { href: '/account.html',       icon: '👤', label: 'ACCOUNT',  key: 'account' },
  ].map(function(item) {
    var active = item.key === page ? ' active' : '';
    return '<a class="slipiq-mobile-nav-item' + active + '" href="' + item.href + '">' +
      '<span class="nav-icon-emoji">' + item.icon + '</span>' +
      '<span class="nav-label-text">' + item.label + '</span>' +
    '</a>';
  }).join('');

  document.body.appendChild(nav);

  // Push body content up
  document.body.style.paddingBottom = 'calc(56px + env(safe-area-inset-bottom, 0px))';
})();
