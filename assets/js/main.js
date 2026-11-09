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
})();
