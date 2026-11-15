/**
 * 画面の色（自動・ライト・ダーク）を切り替える。
 *
 * 色がちらつかないよう、<head> で読み込み、描画の前に data-theme を付ける。
 * 「自動」のときは何も保存せず、端末の設定（prefers-color-scheme）に合わせる。
 */
(function () {
  var THEME_KEY = 'proposedDateTheme';
  var MODES = ['auto', 'light', 'dark'];
  var LABELS = { auto: '表示：自動', light: '表示：ライト', dark: '表示：ダーク' };

  function readMode() {
    try {
      var saved = window.localStorage.getItem(THEME_KEY);
      return MODES.indexOf(saved) >= 0 ? saved : 'auto';
    } catch (error) {
      return 'auto';
    }
  }

  function saveMode(mode) {
    try {
      if (mode === 'auto') {
        window.localStorage.removeItem(THEME_KEY);
      } else {
        window.localStorage.setItem(THEME_KEY, mode);
      }
    } catch (error) {
      // 保存できなくても、このページを開いている間は切り替わる
    }
  }

  function applyMode(mode) {
    if (mode === 'auto') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', mode);
    }
  }

  var mode = readMode();
  applyMode(mode);

  document.addEventListener('DOMContentLoaded', function () {
    var button = document.getElementById('themeButton');

    if (!button) {
      return;
    }

    function render() {
      button.textContent = LABELS[mode];
      button.title = '画面の色を切り替えます（自動 → ライト → ダーク）';
    }

    render();

    button.addEventListener('click', function () {
      mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
      applyMode(mode);
      saveMode(mode);
      render();
    });
  });
})();
