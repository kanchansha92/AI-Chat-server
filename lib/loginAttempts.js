// Tracks failed sign-in attempts per email, in memory.
//
// Brief (section 6.3 / 9.1): "after 5 wrong attempts: - too many tries.
// give it five minutes and come back." Process-local and intentionally
// simple; a multi-instance deployment behind a load balancer should back
// this with Redis instead (same three functions, different store).

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;

const attempts = new Map();

function keyFor(email) {
  return email.trim().toLowerCase();
}

function isLockedOut(email) {
  const state = attempts.get(keyFor(email));
  if (!state || !state.lockedUntil) return false;
  if (Date.now() >= state.lockedUntil) {
    attempts.delete(keyFor(email));
    return false;
  }
  return true;
}

function recordFailedAttempt(email) {
  const key = keyFor(email);
  const state = attempts.get(key) || { count: 0, lockedUntil: null };
  state.count += 1;
  if (state.count >= MAX_ATTEMPTS) {
    state.lockedUntil = Date.now() + LOCKOUT_MS;
  }
  attempts.set(key, state);
}

function clearAttempts(email) {
  attempts.delete(keyFor(email));
}

module.exports = { isLockedOut, recordFailedAttempt, clearAttempts };
