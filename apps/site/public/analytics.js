// Umami custom event tracking for Nouride
(function () {
  document.addEventListener('click', function (e) {
    if (!window.umami) return;

    // 1. Track binary download links (*.tar.gz)
    var a = e.target && e.target.closest ? e.target.closest('a') : null;
    if (a && a.href && a.href.indexOf('.tar.gz') !== -1) {
      var parts = a.href.split('/');
      var filename = parts[parts.length - 1];
      window.umami.track('download-binary', { file: filename, url: a.href });
      return;
    }

    // 2. Track install command / code copy events
    var copyBtn = e.target && e.target.closest ? e.target.closest('button[data-copy], [data-code]') : null;
    if (copyBtn) {
      var cmd = copyBtn.getAttribute('data-copy') || copyBtn.getAttribute('data-code') || '';
      if (cmd.indexOf('install.sh') !== -1) {
        window.umami.track('copy-install-command');
      }
    }
  });
})();
