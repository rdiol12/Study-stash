// One global concurrency gate shared by every heavy download path (DRM in
// keyframe.js and 1080p in hd-runner.js). Without it each pool enforced its own
// limit, so "4 parallel" could run 4 DRM + 4 HD = 8 at once. Acquiring a slot
// here caps the TOTAL across pools to the user's chosen number.

let max = 3;
let active = 0;
const waiters = [];

function pump() {
  while (active < max && waiters.length) {
    active += 1;
    waiters.shift()();
  }
}

export function setConcurrency(n) {
  max = Math.max(1, Number(n) || 1);
  pump();
}

export function acquireSlot() {
  return new Promise((resolve) => { waiters.push(resolve); pump(); });
}

export function releaseSlot() {
  active = Math.max(0, active - 1);
  pump();
}
