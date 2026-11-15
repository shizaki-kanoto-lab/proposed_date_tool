/**
 * ライト / ダークの切り替え。
 *
 * トップページや紹介ページと同じ動き・同じ保存先（localStorage の theme）にそろえている。
 * 同じドメインなので、どこかで選んだ色はほかのページにも引き継がれる。
 * 選ぶまでは端末の設定（prefers-color-scheme）に合わせる。
 * 色がちらつかないよう、<head> で読み込み、描画の前に data-theme を付ける。
 */
(function () {
  var THEME_KEY = 'theme';
  var root = document.documentElement;
  var media = window.matchMedia('(prefers-color-scheme: dark)');

  function saved() {
    try {
      var theme = window.localStorage.getItem(THEME_KEY);
      return theme === 'light' || theme === 'dark' ? theme : null;
    } catch (error) {
      return null;
    }
  }

  function apply(theme) {
    root.setAttribute('data-theme', theme);

    var button = document.getElementById('themeButton');

    if (button) {
      button.setAttribute('aria-label', theme === 'dark' ? 'ライトモードに切り替える' : 'ダークモードに切り替える');
    }
  }

  apply(saved() || (media.matches ? 'dark' : 'light'));

  document.addEventListener('DOMContentLoaded', function () {
    var button = document.getElementById('themeButton');

    if (!button) {
      return;
    }

    apply(root.getAttribute('data-theme'));

    button.addEventListener('click', function () {
      var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      apply(next);

      try {
        window.localStorage.setItem(THEME_KEY, next);
      } catch (error) {
        // 保存できなくても、このページを開いている間は切り替わる
      }
    });
  });

  // 手動で選んでいない間は、端末の設定が変わったら合わせる
  media.addEventListener('change', function (event) {
    if (!saved()) {
      apply(event.matches ? 'dark' : 'light');
    }
  });
})();
