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
