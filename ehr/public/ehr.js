/* Clinic Ready EHR. Small progressive enhancements (the app works without JS). */
(function () {
  "use strict";
  // <form data-confirm="Are you sure?"> or <button data-confirm="...">
  document.addEventListener("submit", function (e) {
    var form = e.target;
    var btn = e.submitter;
    var msg = (btn && btn.getAttribute("data-confirm")) || form.getAttribute("data-confirm");
    if (msg && !window.confirm(msg)) e.preventDefault();
  });
  // <button data-print> prints the page
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-print]");
    if (t) { e.preventDefault(); window.print(); }
  });
  // Warn before leaving a form with unsaved edits: <form data-dirty-check>
  document.querySelectorAll("form[data-dirty-check]").forEach(function (form) {
    var dirty = false;
    form.addEventListener("input", function () { dirty = true; });
    form.addEventListener("submit", function () { dirty = false; });
    window.addEventListener("beforeunload", function (e) { if (dirty) { e.preventDefault(); e.returnValue = ""; } });
  });
  // Live total for questionnaires: <form data-score> sums checked radio values into [data-score-total]
  document.querySelectorAll("form[data-score]").forEach(function (form) {
    var out = form.querySelector("[data-score-total]");
    function update() {
      var sum = 0;
      form.querySelectorAll("input[type=radio]:checked").forEach(function (r) { sum += Number(r.value) || 0; });
      if (out) out.textContent = String(sum);
    }
    form.addEventListener("change", update);
    update();
  });
  // Treatment plan objective: choosing an instrument fills an empty baseline from the latest score
  // (<select data-prefill-baseline="inputId"> with <option data-latest="n">).
  document.querySelectorAll("select[data-prefill-baseline]").forEach(function (sel) {
    sel.addEventListener("change", function () {
      var opt = sel.options[sel.selectedIndex];
      var target = document.getElementById(sel.getAttribute("data-prefill-baseline"));
      var mt = sel.form && sel.form.querySelector("select[name=measure_type]");
      if (sel.value && mt) mt.value = "instrument";
      if (target && opt && opt.getAttribute("data-latest") !== null && !target.value) target.value = opt.getAttribute("data-latest");
    });
  });
  // Patient pictures: <form data-photo-upload>. Resize to max 1600px and re-encode as JPEG in the browser
  // (smaller uploads; drops EXIF such as GPS location), then send as a data: URL in image_data.
  document.querySelectorAll("form[data-photo-upload]").forEach(function (form) {
    var file = form.querySelector("[data-photo-file]"), out = form.querySelector("input[name=image_data]");
    var preview = form.querySelector("[data-photo-preview]"), status = form.querySelector("[data-photo-status]");
    var busy = null;
    function say(t) { if (status) status.textContent = t; }
    function load(f) {
      if (window.createImageBitmap) return createImageBitmap(f, { imageOrientation: "from-image" }).catch(function () { return createImageBitmap(f); });
      return new Promise(function (ok, bad) {
        var r = new FileReader();
        r.onload = function () { var img = new Image(); img.onload = function () { ok(img); }; img.onerror = bad; img.src = r.result; };
        r.onerror = bad; r.readAsDataURL(f);
      });
    }
    file.addEventListener("change", function () {
      out.value = ""; if (preview) preview.hidden = true;
      var f = file.files && file.files[0];
      if (!f) return;
      say("Preparing picture…");
      busy = load(f).then(function (img) {
        var png = form.getAttribute("data-format") === "png";
        var w = img.width, h = img.height, max = Number(form.getAttribute("data-max")) || 1600, k = Math.min(1, max / Math.max(w, h));
        var c = document.createElement("canvas");
        c.width = Math.round(w * k); c.height = Math.round(h * k);
        var ctx = c.getContext("2d"); if (!png) { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height); }
        ctx.drawImage(img, 0, 0, c.width, c.height);
        out.value = png ? c.toDataURL("image/png") : c.toDataURL("image/jpeg", 0.85);
        if (preview) { preview.src = out.value; preview.hidden = false; }
        say("Ready to upload.");
      }).catch(function () { say("That file couldn't be read as a picture. Try a JPEG or PNG."); })
        .then(function () { busy = null; });
    });
    form.addEventListener("submit", function (e) {
      if (busy) { e.preventDefault(); say("Still preparing the picture, try again in a moment."); return; }
      if (!out.value) { e.preventDefault(); say("Choose a picture first."); return; }
      file.disabled = true; // don't send the original file
      say("Uploading…");
    });
  });
  // Phone "More" sheet: close when tapping outside it or pressing Escape.
  var more = document.querySelector(".bottomnav__more");
  if (more) {
    document.addEventListener("click", function (e) { if (more.open && !e.target.closest(".bottomnav__sheet") && !e.target.closest(".bottomnav__more > summary")) more.open = false; });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") more.open = false; });
  }
  // Home-screen app: register the service worker (it caches no patient data; see /ehr/sw.js).
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("/ehr/sw.js", { scope: "/ehr" }).catch(function () {});
  }
  // iPhone/iPad in Safari (not yet installed): show how to add the app to the home screen. Dismissable.
  (function () {
    var ua = navigator.userAgent;
    var ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    var standalone = window.navigator.standalone === true || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
    var dismissed = false;
    try { dismissed = localStorage.getItem("cr-install-dismissed") === "1"; } catch (e) {}
    var spot = document.querySelector("[data-install-hint]") || (document.querySelector(".hero") && document.querySelector(".hero").parentNode);
    if (!ios || standalone || !spot) return;
    if (dismissed && !document.querySelector("[data-install-hint]")) return;
    var meta = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    var appName = (meta && meta.getAttribute("content")) || "Clinic Ready";
    var iconLink = document.querySelector('link[rel="apple-touch-icon"]');
    var iconSrc = (iconLink && iconLink.getAttribute("href")) || "/ehr/static/icons/icon-180.png";
    var box = document.createElement("div");
    box.className = "install-hint";
    box.setAttribute("role", "note");
    box.innerHTML = '<img src="' + iconSrc.replace(/["<>]/g, "") + '" alt="" width="44" height="44">' +
      '<div><strong>Get the ' + appName.replace(/[<>&"]/g, "") + ' app</strong><span>Tap <svg viewBox="0 0 24 24" width="16" height="16" aria-label="Share" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 8l5-5 5 5M5 12v8h14v-8"/></svg> <b>Share</b> in Safari (on newer iPhones it\'s under <b>···</b>), then <b>Add to Home Screen</b>.</span></div>' +
      '<button type="button" aria-label="Dismiss">&times;</button>';
    box.querySelector("button").addEventListener("click", function () { box.remove(); try { localStorage.setItem("cr-install-dismissed", "1"); } catch (e) {} });
    var target = document.querySelector("[data-install-hint]");
    if (target) target.appendChild(box); else spot.insertBefore(box, spot.firstChild);
  })();
  // Note scanner: <form data-pdf-upload> reads the chosen PDF into pdf_data (the file input itself isn't sent).
  document.querySelectorAll("form[data-pdf-upload]").forEach(function (form) {
    var file = form.querySelector("[data-pdf-file]"), out = form.querySelector("input[name=pdf_data]");
    var status = form.querySelector("[data-pdf-status]"), busy = false;
    function say(t) { if (status) status.textContent = t; }
    file.addEventListener("change", function () {
      out.value = "";
      var f = file.files && file.files[0];
      if (!f) return;
      if (f.type && f.type !== "application/pdf") { say("Choose a PDF file."); return; }
      if (f.size > 10 * 1024 * 1024) { say("That PDF is over 10 MB."); return; }
      busy = true; say("Reading PDF…");
      var r = new FileReader();
      r.onload = function () { out.value = String(r.result).replace(/^data:[^;]*;/, "data:application/pdf;"); busy = false; say("Ready to scan (" + Math.max(1, Math.round(f.size / 1024)) + " KB)."); };
      r.onerror = function () { busy = false; say("That file couldn't be read."); };
      r.readAsDataURL(f);
    });
    form.addEventListener("submit", function (e) {
      if (busy) { e.preventDefault(); say("Still reading the PDF, try again in a moment."); return; }
      if (!out.value) { e.preventDefault(); say("Choose a PDF first."); return; }
      file.disabled = true;
      var btn = form.querySelector("button[type=submit]");
      if (btn) { btn.disabled = true; btn.textContent = "Scanning… this can take a minute"; }
      say("Scanning with AI…");
    });
  });
  // Live signature countdowns: <span data-deadline="ISO" data-total-hours="24">
  function tick() {
    document.querySelectorAll("[data-deadline]").forEach(function (el) {
      var ms = Date.parse(el.getAttribute("data-deadline")) - Date.now();
      if (isNaN(ms)) return;
      var total = Number(el.getAttribute("data-total-hours")) || 24;
      var abs = Math.abs(ms), d = Math.floor(abs / 864e5), h = Math.floor((abs % 864e5) / 36e5), m = Math.floor((abs % 36e5) / 6e4);
      var span = d ? d + "d " + h + "h" : h ? h + "h " + m + "m" : m + "m";
      el.textContent = ms >= 0 ? "Due in " + span : "Overdue by " + span;
      var tone = ms < 0 ? "bad" : ms < Math.min(6, total / 4) * 36e5 ? "warn" : "info";
      el.className = el.className.replace(/badge--\w+/, "badge--" + tone);
    });
  }
  if (document.querySelector("[data-deadline]")) { tick(); setInterval(tick, 30000); }
    // Idle warning: sessions expire server-side; nudge the user after 25 minutes idle.
  var idleMs = 25 * 60 * 1000, timer;
  function reset() { clearTimeout(timer); timer = setTimeout(function () {
    var bar = document.createElement("div");
    bar.className = "alert alert--warn"; bar.setAttribute("role", "alert");
    bar.style.cssText = "position:fixed;bottom:1rem;right:1rem;z-index:50;max-width:340px";
    bar.textContent = "You'll be signed out soon for inactivity. Save your work.";
    document.body.appendChild(bar);
  }, idleMs); }
  if (document.querySelector(".app")) { ["keydown", "click", "input"].forEach(function (ev) { document.addEventListener(ev, reset); }); reset(); }
})();
