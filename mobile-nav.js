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
  // mobile-nav.js
(function() {
  if (window.innerWidth > 768 || !window.Capacitor) return;
  
  var page = window.location.pathname.split('/').pop() || 'index.html';
  var noBackPages = ['home.html', 'index.html', ''];
  
  if (noBackPages.includes(page)) return;

  // Inject safe area CSS
  var styleEl = document.createElement('style');
  styleEl.textContent = `
    .mobile-back-btn {
      position: fixed;
      top: env(safe-area-inset-top, 12px);
      left: 12px;
      z-index: 9999;
      background: rgba(10, 22, 40, 0.9);
      border: 1px solid rgba(0, 200, 248, 0.3);
      color: #00c8f8;
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      font-weight: 700;
      padding: 8px 14px;
      border-radius: 20px;
      cursor: pointer;
      backdrop-filter: blur(10px);
      display: flex;
      align-items: center;
      gap: 6px;
      letter-spacing: 1px;
      margin-top: calc(env(safe-area-inset-top, 0px) + 8px);
    }
    .mobile-back-btn:active {
      background: rgba(0, 200, 248, 0.2);
    }
    /* Push page content down so back btn doesn't overlap */
    body { 
      padding-top: calc(env(safe-area-inset-top, 0px) + 52px) !important; 
    }
  `;
  document.head.appendChild(styleEl);

  var btn = document.createElement('button');
  btn.className = 'mobile-back-btn';
  btn.innerHTML = '← HOME';
  btn.onclick = function() {
    if (document.referrer && document.referrer.includes(window.location.host)) {
      history.back();
    } else {
      window.location.href = 'home.html';
    }
  };
  document.body.appendChild(btn);
  
  // Also inject bottom nav on sub-pages for consistency
  var bottomNav = document.createElement('div');
  bottomNav.style.cssText = `
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    background: #070d1a;
    border-top: 1px solid #152d55;
    display: flex;
    z-index: 200;
    height: calc(52px + env(safe-area-inset-bottom, 0px));
    padding-bottom: env(safe-area-inset-bottom, 0px);
  `;
  bottomNav.innerHTML = `
    <button onclick="window.location.href='home.html'" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;cursor:pointer;color:#3a5a7a;font-family:'JetBrains Mono',monospace;font-size:7px;letter-spacing:0.5px;border:none;background:none;padding:4px 0">
      <span style="font-size:18px">⚽</span><span>MATCHES</span>
    </button>
    <button onclick="window.location.href='leagues.html'" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;cursor:pointer;color:${page==='leagues.html'?'#00c8f8':'#3a5a7a'};font-family:'JetBrains Mono',monospace;font-size:7px;letter-spacing:0.5px;border:none;background:none;padding:4px 0">
      <span style="font-size:18px">🏆</span><span>LEAGUES</span>
    </button>
    <button onclick="window.location.href='home.html#parlays'" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;cursor:pointer;color:#3a5a7a;font-family:'JetBrains Mono',monospace;font-size:7px;letter-spacing:0.5px;border:none;background:none;padding:4px 0">
      <span style="font-size:18px">🎯</span><span>PARLAYS</span>
    </button>
    <button onclick="window.location.href='account.html'" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;cursor:pointer;color:${page==='account.html'?'#00c8f8':'#3a5a7a'};font-family:'JetBrains Mono',monospace;font-size:7px;letter-spacing:0.5px;border:none;background:none;padding:4px 0">
      <span style="font-size:18px">👤</span><span>ACCOUNT</span>
    </button>
    <button onclick="window.location.href='subscriptions.html'" style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;cursor:pointer;color:${page==='subscriptions.html'||page==='store.html'?'#ffd700':'#3a5a7a'};font-family:'JetBrains Mono',monospace;font-size:7px;letter-spacing:0.5px;border:none;background:none;padding:4px 0">
      <span style="font-size:18px">⭐</span><span>UPGRADE</span>
    </button>
  `;
  document.body.appendChild(bottomNav);
  document.body.style.paddingBottom = 'calc(52px + env(safe-area-inset-bottom, 0px))';
})();
    // ── BUILD BOTTOM NAV ──────────────────────────────────────
    var nav = document.createElement('nav');
    nav.className = 'slipiq-mobile-nav';
    nav.setAttribute('role', 'navigation');
    nav.setAttribute('aria-label', 'Main navigation');
  
    NAV_ITEMS.forEach(function (item) {
      var btn = document.createElement('button');
      btn.className = 'slipiq-mobile-nav-item' + (isActive(item) ? ' active' : '');
      btn.type = 'button';

      btn.addEventListener('click', function (e) {
        e.preventDefault();
        // Parlays special case
        if (item.match === '__parlays__') {
          if (typeof openParlayOverlay === 'function') {
            openParlayOverlay();
          } else if (typeof showPage === 'function') {
            var parlaysNav = document.getElementById('nav-parlays');
            showPage('parlays', parlaysNav);
            document.querySelectorAll('.slipiq-mobile-nav-item').forEach(function (b) {
              b.classList.remove('active');
            });
            btn.classList.add('active');
          } else {
            window.location.href = 'home.html';
          }
          return;
        }
        // All other nav items — use window.location.href so Capacitor stays in-app
        window.location.href = item.href;
      });
  
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