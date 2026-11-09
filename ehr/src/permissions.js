"use strict";

// Permission keys used across modules. Check with can(req.user, key)
// or the requirePerm(key) middleware from auth.js.
const ROLE_PERMS = {
  admin: ["patients:read", "patients:write", "clinical:read", "clinical:write", "schedule:read", "schedule:write",
    "billing:read", "billing:write", "requests:manage", "admin"],
  clinician: ["patients:read", "patients:write", "clinical:read", "clinical:write", "schedule:read", "schedule:write",
    "billing:read"],
  frontdesk: ["patients:read", "patients:write", "schedule:read", "schedule:write", "requests:manage", "billing:read"],
  billing: ["patients:read", "schedule:read", "billing:read", "billing:write"],
};
const ROLES = Object.keys(ROLE_PERMS);

function can(user, perm) {
  return !!user && user.active === 1 && (ROLE_PERMS[user.role] || []).includes(perm);
}

module.exports = { ROLE_PERMS, ROLES, can };
