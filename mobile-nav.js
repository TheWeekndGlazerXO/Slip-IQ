/**
 * SLIP IQ — SHARED MOBILE NAV SCRIPT
 * Place this file at: /mobile-nav.js
 * Then add ONE line to every page's <body> (before </body>):
 *   <script src="/mobile-nav.js"></script>
 *
 * It detects the current page from the URL and highlights
 * the correct nav item automatically on every page.
 */

(function () {
    // Only run on mobile
    if (window.innerWidth > 768) return;
  
    // ── NAV CONFIG ────────────────────────────────────────────
    // Each item: { icon, label, href, match }
    // match: string that must appear in the pathname to mark it active
    var NAV_ITEMS = [
      { icon: '⚽', label: 'MATCHES',  href: 'home.html',          match: 'home' },
      { icon: '🏆', label: 'LEAGUES',  href: 'leagues.html',       match: 'leagues' },
      { icon: '🎯', label: 'PARLAYS',  href: 'home.html#parlays',  match: '__parlays__' }, // handled separately on home
      { icon: '👤', label: 'ACCOUNT',  href: 'account.html',       match: 'account' },
      { icon: '⚡', label: 'UPGRADE',  href: 'subscriptions.html', match: 'subscriptions' },
    ];
  
    // Detect current page
    var path = window.location.pathname.toLowerCase();
    var hash = window.location.hash;
  
    function isActive(item) {
      if (item.match === '__parlays__') return false; // never auto-active
      return path.includes(item.match);
    }
  
    // ── BUILD BOTTOM NAV ──────────────────────────────────────
    var nav = document.createElement('nav');
    nav.className = 'slipiq-mobile-nav';
    nav.setAttribute('role', 'navigation');
    nav.setAttribute('aria-label', 'Main navigation');
  
    NAV_ITEMS.forEach(function (item) {
      var btn = document.createElement('a');
      btn.className = 'slipiq-mobile-nav-item' + (isActive(item) ? ' active' : '');
      btn.href = item.href;
  
      // Special case: Parlays on home page — scroll/activate via JS
      if (item.match === '__parlays__') {
        btn.href = '#';
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          // If we're on home.html and the parlayOverlay function exists, open it
          if (typeof openParlayOverlay === 'function') {
            openParlayOverlay();
          } else if (typeof showPage === 'function') {
            // Home page multi-tab: switch to parlays tab
            var parlaysNav = document.getElementById('nav-parlays');
            showPage('parlays', parlaysNav);
            // Update mobile nav active state
            document.querySelectorAll('.slipiq-mobile-nav-item').forEach(function (b) {
              b.classList.remove('active');
            });
            btn.classList.add('active');
          } else {
            window.location.href = 'home.html';
          }
        });
      }
  
      btn.innerHTML =
        '<span class="nav-icon-emoji" aria-hidden="true">' + item.icon + '</span>' +
        '<span class="nav-label-text">' + item.label + '</span>';
  
      nav.appendChild(btn);
    });
  
    document.body.appendChild(nav);
  
    // ── PARLAY FAB (only on home.html) ───────────────────────
    if (path.includes('home') || path === '/' || path.endsWith('/')) {
      var fab = document.createElement('button');
      fab.id = 'slipiqParlayFab';
      fab.className = 'slipiq-parlay-fab';
      fab.setAttribute('aria-label', 'View parlay builder');
      fab.textContent = '🎯 BUILD PARLAY';
  
      fab.addEventListener('click', function () {
        if (typeof openParlayOverlay === 'function') {
          openParlayOverlay();
        }
      });
  
      document.body.appendChild(fab);
  
      // Hook into the app's renderParlay function to update the FAB
      // We wait a tick for the page JS to load first
      setTimeout(function () {
        if (typeof renderParlay === 'function') {
          var _orig = renderParlay;
          window.renderParlay = function () {
            _orig.apply(this, arguments);
            updateParlayFab();
          };
        }
      }, 500);
    }
  
    // ── UPDATE PARLAY FAB ─────────────────────────────────────
    function updateParlayFab() {
      var fab = document.getElementById('slipiqParlayFab');
      if (!fab) return;
  
      // parlaySelections is a global on home.html
      var selections = (typeof parlaySelections !== 'undefined') ? parlaySelections : [];
      var count = selections.length;
  
      if (count > 0) {
        fab.style.display = 'block';
        var combinedOdds = selections.reduce(function (p, s) { return p * (s.odds || 1); }, 1);
        fab.textContent = '🎯 ' + count + ' LEG' + (count !== 1 ? 'S' : '') + ' · ' + combinedOdds.toFixed(2) + 'x';
      } else {
        fab.style.display = 'none';
      }
    }
  
    // ── RESIZE GUARD ──────────────────────────────────────────
    // Remove the mobile nav if user resizes to desktop
    window.addEventListener('resize', function () {
      if (window.innerWidth > 768) {
        var existing = document.querySelector('.slipiq-mobile-nav');
        if (existing) existing.remove();
        var existingFab = document.getElementById('slipiqParlayFab');
        if (existingFab) existingFab.remove();
      }
    });
  
  })();