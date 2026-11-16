/**
 * 画面の色の切り替え（自動・ライト・ダークの3つ）。
 *
 * トップページや紹介ページと同じ動き・同じ保存先（localStorage の theme）にそろえている。
 * 同じドメインなので、どこかで選んだ色はほかのページにも引き継がれる。
 * 「自動」のときは何も保存せず、端末の設定（prefers-color-scheme）に合わせる。
 * 色がちらつかないよう、<head> で読み込み、描画の前に data-theme を付ける。
 */
(function () {
  var THEME_KEY = 'theme';
  var root = document.documentElement;
  var media = window.matchMedia('(prefers-color-scheme: dark)');
  var NAMES = { auto: '自動', light: 'ライト', dark: 'ダーク' };

  // 保存がなければ「自動」（端末の設定に合わせる）
  function saved() {
    try {
      var theme = window.localStorage.getItem(THEME_KEY);
      return theme === 'light' || theme === 'dark' ? theme : 'auto';
    } catch (error) {
      return 'auto';
    }
  }

  // 押すたびに見た目が変わる順：自動 → 端末と逆 → 端末と同じ → 自動
  function next(mode) {
    var order = media.matches ? ['auto', 'light', 'dark'] : ['auto', 'dark', 'light'];
    return order[(order.indexOf(mode) + 1) % 3];
  }

  function apply(mode) {
    if (mode === 'auto') {
      root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', mode);
    }

    var button = document.getElementById('themeButton');

    if (button) {
      var label = '表示：' + NAMES[mode] + (mode === 'auto' ? '（OS に合わせる）' : '') + '。押すと' + NAMES[next(mode)] + 'に切り替え';
      button.setAttribute('data-mode', mode);
      button.setAttribute('aria-label', label);
      button.title = label;
    }
  }

  var mode = saved();
  apply(mode);

  document.addEventListener('DOMContentLoaded', function () {
    var button = document.getElementById('themeButton');

    if (!button) {
      return;
    }

    apply(mode);

    button.addEventListener('click', function () {
      mode = next(mode);
      apply(mode);

      try {
        if (mode === 'auto') {
          window.localStorage.removeItem(THEME_KEY);
        } else {
          window.localStorage.setItem(THEME_KEY, mode);
        }
      } catch (error) {
        // 保存できなくても、この画面を開いている間は切り替わる
      }
    });
  });

  // 端末の設定が変わったら、色（自動のとき）と次の行き先の表示を合わせ直す
  media.addEventListener('change', function () {
    apply(mode);
  });
})();
