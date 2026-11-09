/* Clinic Ready — shared site behavior (no dependencies) */
(function () {
  "use strict";
  document.documentElement.classList.add("js");

  // Mobile nav toggle
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.getElementById("site-nav");
  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && nav.classList.contains("is-open")) {
        nav.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
        toggle.focus();
      }
    });
  }

  // Mark current page in nav
  var path = location.pathname.split("/").pop() || "index.html";
  document.querySelectorAll(".site-nav a[href]").forEach(function (a) {
    if (a.getAttribute("href") === path && !a.classList.contains("btn")) {
      a.setAttribute("aria-current", "page");
    }
  });

  // Footer year
  document.querySelectorAll("[data-year]").forEach(function (el) {
    el.textContent = new Date().getFullYear();
  });

  // Scroll reveal
  var reveals = document.querySelectorAll(".reveal");
  if ("IntersectionObserver" in window && reveals.length) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: "0px 0px -10% 0px" });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("is-visible"); });
  }

  // Simple client-side validation for forms marked data-validate.
  // Note: this is a static site. Wire the form `action` to a HIPAA-compliant
  // form processor before going live — do not collect PHI over plain email.
  document.querySelectorAll("form[data-validate]").forEach(function (form) {
    form.setAttribute("novalidate", "");
    form.addEventListener("submit", function (e) {
      var firstInvalid = null;
      form.querySelectorAll("[required]").forEach(function (field) {
        var errId = field.id + "-error";
        var existing = document.getElementById(errId);
        var valid = field.type === "checkbox" ? field.checked : field.checkValidity() && field.value.trim() !== "";
        if (!valid) {
          field.setAttribute("aria-invalid", "true");
          if (!existing) {
            var msg = document.createElement("p");
            msg.className = "field-error";
            msg.id = errId;
            msg.textContent = field.dataset.error || "Please complete this field.";
            (field.closest(".field") || field.parentNode).appendChild(msg);
            var describedBy = (field.getAttribute("aria-describedby") || "").split(" ").filter(Boolean);
            describedBy.push(errId);
            field.setAttribute("aria-describedby", describedBy.join(" "));
          }
          if (!firstInvalid) firstInvalid = field;
        } else {
          field.removeAttribute("aria-invalid");
          if (existing) existing.remove();
        }
      });
      if (firstInvalid) {
        e.preventDefault();
        firstInvalid.focus();
        return;
      }
      var endpoint = form.getAttribute("data-endpoint");
      if (endpoint && window.fetch) {
        e.preventDefault();
        submitToEndpoint(form, endpoint);
        return;
      }
      if (!form.getAttribute("action")) {
        e.preventDefault();
        var status = form.querySelector(".form-status");
        if (status) {
          status.hidden = false;
          status.focus();
        }
        form.reset();
      }
    });
  });

  function showStatus(form, message, isError) {
    var status = form.querySelector(".form-status");
    if (!status) return;
    if (!status.dataset.success) status.dataset.success = status.textContent;
    status.textContent = message || status.dataset.success;
    status.style.background = isError ? "#fbe5df" : "";
    status.style.color = isError ? "#a2361c" : "";
    status.hidden = false;
    status.focus();
  }

  // Submit a validated form as JSON to a same-origin API endpoint.
  function submitToEndpoint(form, endpoint) {
    var button = form.querySelector('[type="submit"]');
    if (button) { button.disabled = true; button.dataset.label = button.textContent; button.textContent = "Sending…"; }
    var data = {};
    new FormData(form).forEach(function (value, key) { data[key] = value; });
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(data),
      credentials: "same-origin"
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) { return { status: res.status, body: body }; });
    }).then(function (r) {
      if (r.status === 200 || r.status === 201) {
        form.reset();
        showStatus(form);
      } else if (r.status === 400 && r.body && r.body.fields) {
        var first = null;
        Object.keys(r.body.fields).forEach(function (name) {
          var field = form.querySelector('[name="' + name + '"]');
          if (field) { field.setAttribute("aria-invalid", "true"); if (!first) first = field; }
        });
        showStatus(form, "Please check the highlighted fields and try again.", true);
        if (first) first.focus();
      } else if (r.status === 429) {
        showStatus(form, "We've received several requests from this device. Please call us at (555) 010-0123.", true);
      } else {
        showStatus(form, "Something went wrong sending your request. Please call us at (555) 010-0123.", true);
      }
    }).catch(function () {
      showStatus(form, "We couldn't reach our server. Please call us at (555) 010-0123.", true);
    }).then(function () {
      if (button) { button.disabled = false; button.textContent = button.dataset.label; }
    });
  }

  // Non-JS fallback lands on ?submitted=1
  if (/[?&]submitted=1/.test(location.search)) {
    var f = document.querySelector("form[data-endpoint]");
    if (f) showStatus(f);
  }
})();
