// Google AdSense Auto ads for the guide/about/contact pages (index.html loads ads from app.js).
// Uses the publisher ID in config.js; blank means no ads.
(function () {
  var c = String((window.FLH_CONFIG || {}).ADSENSE_CLIENT || "").trim();
  if (!/^ca-pub-\d{10,20}$/.test(c)) return;
  var s = document.createElement("script");
  s.async = true; s.crossOrigin = "anonymous";
  s.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" + c;
  document.head.appendChild(s);
})();
