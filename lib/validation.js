const { authCopy, onboardingCopy, characterCopy, journalCopy, chatCopy, groupCopy, profileCopy } = require('./copy');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NAME_MAX_LEN = 40;
const PASSWORD_MIN_LEN = 10;
const MIN_AGE = 18;

const COMMON_WEAK_PASSWORDS = new Set([
  'passwordpassword',
  'password123456',
  '1234567890123',
  'qwertyuiopasdf',
  'letmeinletmein',
  'iloveyouiloveyou',
]);

function isObviouslyWeak(password) {
  if (COMMON_WEAK_PASSWORDS.has(password.toLowerCase())) return true;
  const allSameChar = new Set(password).size === 1;
  if (allSameChar) return true;
  const isSequential = Array.from(password).every((char, i, arr) => {
    if (i === 0) return true;
    return char.charCodeAt(0) - arr[i - 1].charCodeAt(0) === 1;
  });
  if (isSequential) return true;
  return false;
}

/**
 * Parses a DOB into a UTC-anchored Date, or null if the string doesn't
 * parse to a real calendar date at all.
 *
 * IMPORTANT - this is the fix for the timezone bug: `new Date("2008-07-09")`
 * parses as UTC midnight. From here on we read it back with getUTCFullYear
 * /getUTCMonth/getUTCDate ONLY. Mixing that UTC-parsed value with the
 * *local* getMonth()/getDate() accessors (as the original code did) shifts
 * the effective date by up to a day depending on the server's timezone -
 * verified this actually lets an underage signup through when the server
 * runs west of UTC and the request lands close to midnight UTC.
 */
function parseDob(dobInput) {
  if (!dobInput) return null;
  const date = new Date(dobInput);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function ageOnDate(dobDate, todayDate) {
  let age = todayDate.getUTCFullYear() - dobDate.getUTCFullYear();
  const monthDiff = todayDate.getUTCMonth() - dobDate.getUTCMonth();
  const dayDiff = todayDate.getUTCDate() - dobDate.getUTCDate();
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) age -= 1;
  return age;
}

/**
 * Validates registration input against the brief's rules. Returns
 * { errors, dob } where `errors` is a list of { field, message } - empty
 * means valid. `dob`, when present, is the parsed UTC Date to persist.
 */
function validateRegister({ name, email, password, dob }) {
  const errors = [];

  if (!name || typeof name !== 'string' || !name.trim()) {
    errors.push({ field: 'name', message: authCopy.register.name.empty });
  } else if (name.trim().length > NAME_MAX_LEN) {
    errors.push({ field: 'name', message: authCopy.register.name.tooLong });
  }

  if (!email || typeof email !== 'string' || !email.trim()) {
    errors.push({ field: 'email', message: authCopy.register.email.empty });
  } else if (!EMAIL_RE.test(email.trim())) {
    errors.push({ field: 'email', message: authCopy.register.email.malformed });
  }

  if (!password || typeof password !== 'string') {
    errors.push({ field: 'password', message: authCopy.register.password.empty });
  } else if (password.length < PASSWORD_MIN_LEN) {
    errors.push({ field: 'password', message: authCopy.register.password.tooShort });
  } else if (isObviouslyWeak(password)) {
    errors.push({ field: 'password', message: authCopy.register.password.tooObvious });
  }

  const dobDate = parseDob(dob);
  if (!dob) {
    errors.push({ field: 'dob', message: authCopy.register.dob.empty });
  } else if (!dobDate) {
    errors.push({ field: 'dob', message: authCopy.register.dob.invalid });
  } else if (ageOnDate(dobDate, new Date()) < MIN_AGE) {
    errors.push({ field: 'dob', message: authCopy.register.dob.underage });
  }

  return { errors, dob: dobDate };
}

function validateLoginShape({ email, password }) {
  if (!email || !password) {
    return [{ field: 'form', message: authCopy.login.missing }];
  }
  return [];
}

// ─── onboarding ──────────────────────────────────────────────────────────────

const THEMES = new Set(['PAPER', 'LAMPLIGHT']);
const INTENTS = new Set(['COMPANY', 'ROLEPLAY', 'JOURNAL', 'LOOKING']);

/**
 * Validates the two onboarding answers. Returns { errors, theme, intent }
 * where theme/intent are the normalized (uppercased) enum values.
 * Accepts lowercase from the client ("paper", "roleplay") - the UI speaks
 * lowercase, the database speaks enums.
 */
function validateOnboarding({ theme, intent }) {
  const errors = [];

  const normTheme = typeof theme === 'string' ? theme.trim().toUpperCase() : '';
  const normIntent = typeof intent === 'string' ? intent.trim().toUpperCase() : '';

  if (!THEMES.has(normTheme)) {
    errors.push({ field: 'theme', message: onboardingCopy.badChoice });
  }
  if (!INTENTS.has(normIntent)) {
    errors.push({ field: 'intent', message: onboardingCopy.badChoice });
  }

  return { errors, theme: normTheme, intent: normIntent };
}

/**
 * The theme on its own, for PATCH /users/me/preferences. Same THEMES set as
 * onboarding, without demanding an `intent` the settings screen never sends.
 */
function validateThemeChoice({ theme }) {
  const normTheme = typeof theme === 'string' ? theme.trim().toUpperCase() : '';
  const errors = THEMES.has(normTheme)
    ? []
    : [{ field: 'theme', message: onboardingCopy.badChoice }];
  return { errors, theme: normTheme };
}

// ─── profile & account ─────────────────────────────────────────────────────
// The settings → "profile & account" screen (mockup 20). Editing name/email
// reuses the register rules (same NAME_MAX_LEN / EMAIL_RE), but as a PATCH:
// only the fields the user actually touched are present, and each is validated
// on its own. DOB is intentionally NOT editable here - the 18+ age gate
// (§12.3) is set once at signup and never relaxed from settings.

/**
 * Validates a profile PATCH. Returns { errors, data } where `data` holds only
 * the validated, normalized fields that were present in the body. `email`, when
 * present, is lowercased+trimmed the same way register/login normalize it, so
 * the uniqueness check and every later read line up (Postgres equality is
 * case-sensitive - see controllers/auth.js).
 */
function validateProfileUpdate({ name, email }) {
  const errors = [];
  const data = {};

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) {
      errors.push({ field: 'name', message: profileCopy.name.empty });
    } else if (name.trim().length > NAME_MAX_LEN) {
      errors.push({ field: 'name', message: profileCopy.name.tooLong });
    } else {
      data.name = name.trim();
    }
  }

  if (email !== undefined) {
    if (typeof email !== 'string' || !email.trim()) {
      errors.push({ field: 'email', message: profileCopy.email.empty });
    } else if (!EMAIL_RE.test(email.trim())) {
      errors.push({ field: 'email', message: profileCopy.email.malformed });
    } else {
      data.email = email.trim().toLowerCase();
    }
  }

  return { errors, data };
}

/**
 * Validates a password change from settings. Both the current and the new
 * password must be present; the new one is held to the same strength rules as
 * registration (min 10, not obviously weak) and must differ from the current
 * one. The *actual* current-password match happens in the controller (it needs
 * bcrypt + the stored hash) - here we only shape the input.
 */
function validatePasswordChange({ currentPassword, newPassword }) {
  const errors = [];

  if (!currentPassword || typeof currentPassword !== 'string') {
    errors.push({ field: 'currentPassword', message: profileCopy.password.currentEmpty });
  }

  if (!newPassword || typeof newPassword !== 'string') {
    errors.push({ field: 'newPassword', message: profileCopy.password.empty });
  } else if (newPassword.length < PASSWORD_MIN_LEN) {
    errors.push({ field: 'newPassword', message: profileCopy.password.tooShort });
  } else if (isObviouslyWeak(newPassword)) {
    errors.push({ field: 'newPassword', message: profileCopy.password.tooObvious });
  } else if (
    typeof currentPassword === 'string' &&
    currentPassword.length > 0 &&
    newPassword === currentPassword
  ) {
    errors.push({ field: 'newPassword', message: profileCopy.password.same });
  }

  return { errors };
}

// ─── forgot / reset password (brief §8.3) ─────────────────────────────────────

/**
 * Shapes a "forgot password" request. We only need a syntactically valid email;
 * whether an account exists is decided in the controller, which always answers
 * the same way to avoid leaking who's registered. Returns { errors, email }
 * with the normalized (trim + lowercase) address, matching auth's normalization.
 */
function validateForgotPassword({ email }) {
  const errors = [];
  let normalized = null;

  if (!email || typeof email !== 'string' || !email.trim()) {
    errors.push({ field: 'email', message: authCopy.register.email.empty });
  } else if (!EMAIL_RE.test(email.trim())) {
    errors.push({ field: 'email', message: authCopy.register.email.malformed });
  } else {
    normalized = email.trim().toLowerCase();
  }

  return { errors, email: normalized };
}

/**
 * Shapes a "reset password" submission: a token must be present, and the new
 * password is held to the same strength rules as registration. The token's
 * validity (signature + expiry) is checked in the controller - here we only make
 * sure it's a non-empty string so the controller isn't handed junk.
 */
function validateResetPassword({ token, password }) {
  const errors = [];

  if (!token || typeof token !== 'string') {
    errors.push({ field: 'token', message: authCopy.reset.linkInvalid });
  }

  if (!password || typeof password !== 'string') {
    errors.push({ field: 'password', message: authCopy.reset.password.empty });
  } else if (password.length < PASSWORD_MIN_LEN) {
    errors.push({ field: 'password', message: authCopy.reset.password.tooShort });
  } else if (isObviouslyWeak(password)) {
    errors.push({ field: 'password', message: authCopy.reset.password.tooObvious });
  }

  return { errors };
}

// ─── characters ──────────────────────────────────────────────────────────────

const CHARACTER_NAME_MAX_LEN = 40; // brief 14.3: character name 1–40 chars
const QUICK_LINE_MAX_LEN = 500; // brief 14.3: character bio 1–500 chars
const ALLOWED_TONES = new Set(['warm', 'dry', 'playful', 'quiet', 'curious', 'sharp']);
const ALLOWED_MODES = new Set(['QUICK', 'DEEP']);
const COLOUR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Normalizes `tones` from whatever the client sent. multipart/form-data
 * flattens everything to strings, so tones may arrive as a JSON string
 * ('["warm","dry"]'), a comma list ('warm,dry'), or a real array (JSON body).
 * Returns an array, or null if it can't be read as one.
 */
function normalizeTones(tones) {
  if (tones == null || tones === '') return [];
  if (Array.isArray(tones)) return tones;
  if (typeof tones === 'string') {
    try {
      const parsed = JSON.parse(tones);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return tones.split(',').map((t) => t.trim()).filter(Boolean);
    }
  }
  return null;
}

/**
 * Validates character input. With { partial: true } (PATCH), missing fields
 * are skipped instead of failing. Returns { errors, data } where `data` holds
 * only the validated, normalized fields that were present.
 */
function validateCharacterInput({ name, colour, quickLine, tones, mode }, { partial = false } = {}) {
  const errors = [];
  const data = {};

  if (name !== undefined || !partial) {
    if (!name || typeof name !== 'string' || !name.trim()) {
      errors.push({ field: 'name', message: characterCopy.name.empty });
    } else if (name.trim().length > CHARACTER_NAME_MAX_LEN) {
      errors.push({ field: 'name', message: characterCopy.name.tooLong });
    } else {
      data.name = name.trim();
    }
  }

  if (colour !== undefined) {
    if (typeof colour !== 'string' || !COLOUR_RE.test(colour.trim())) {
      errors.push({ field: 'colour', message: characterCopy.colour.invalid });
    } else {
      data.colour = colour.trim().toLowerCase();
    }
  }

  if (quickLine !== undefined) {
    if (typeof quickLine !== 'string') {
      errors.push({ field: 'quickLine', message: characterCopy.quickLine.tooLong });
    } else if (quickLine.trim().length > QUICK_LINE_MAX_LEN) {
      errors.push({ field: 'quickLine', message: characterCopy.quickLine.tooLong });
    } else {
      data.quickLine = quickLine.trim();
    }
  }

  if (tones !== undefined) {
    const list = normalizeTones(tones);
    const allStrings = Array.isArray(list) && list.every((t) => typeof t === 'string');
    const allKnown = allStrings && list.every((t) => ALLOWED_TONES.has(t.toLowerCase()));
    if (!allKnown) {
      errors.push({ field: 'tones', message: characterCopy.tones.invalid });
    } else {
      // dedupe, keep order
      data.tones = [...new Set(list.map((t) => t.toLowerCase()))];
    }
  }

  if (mode !== undefined) {
    const normMode = typeof mode === 'string' ? mode.trim().toUpperCase() : '';
    if (!ALLOWED_MODES.has(normMode)) {
      errors.push({ field: 'mode', message: characterCopy.mode.invalid });
    } else {
      data.mode = normMode;
    }
  }

  return { errors, data };
}

// ─── journal ─────────────────────────────────────────────────────────────────

const THREAD_NAME_MAX_LEN = 80; // brief 14.3: journal entry title 1–80 chars
const ENTRY_TITLE_MAX_LEN = 80; // same shape as a title
const ENTRY_BODY_MAX_LEN = 20000; // generous - the journal is a long, slow surface

/**
 * Validates a new/updated thread. `name` ("who or what is it about?") is
 * required; `aboutRealPerson` is an optional boolean toggle. With
 * { partial: true } (PATCH/rename) a missing name is skipped. Returns
 * { errors, data } holding only the validated fields present.
 */
function validateThreadInput({ name, aboutRealPerson, colour }, { partial = false } = {}) {
  const errors = [];
  const data = {};

  if (name !== undefined || !partial) {
    if (!name || typeof name !== 'string' || !name.trim()) {
      errors.push({ field: 'name', message: journalCopy.thread.name.empty });
    } else if (name.trim().length > THREAD_NAME_MAX_LEN) {
      errors.push({ field: 'name', message: journalCopy.thread.name.tooLong });
    } else {
      data.name = name.trim();
    }
  }

  if (aboutRealPerson !== undefined) {
    // accept real booleans and the string forms multipart/JSON might send.
    // Anything else is rejected rather than coerced - Boolean("no") was true,
    // which quietly flipped the toggle the user meant to leave off.
    if (typeof aboutRealPerson === 'boolean') {
      data.aboutRealPerson = aboutRealPerson;
    } else if (aboutRealPerson === 'true' || aboutRealPerson === 'false') {
      data.aboutRealPerson = aboutRealPerson === 'true';
    } else {
      errors.push({ field: 'aboutRealPerson', message: '- that didn\'t look right.' });
    }
  }

  // the sage-gradient card colour (brief §6.11) - optional, same #rrggbb shape
  // a character uses. Without this the column could never be set.
  if (colour !== undefined) {
    if (typeof colour !== 'string' || !COLOUR_RE.test(colour.trim())) {
      errors.push({ field: 'colour', message: characterCopy.colour.invalid });
    } else {
      data.colour = colour.trim().toLowerCase();
    }
  }

  return { errors, data };
}

/**
 * Validates a journal entry. On create (partial: false) the body is required -
 * an empty entry isn't worth saving. `title` is always optional (0–80 chars).
 * With { partial: true } (autosave PATCH) both are skipped when absent.
 */
function validateEntryInput({ title, body }, { partial = false } = {}) {
  const errors = [];
  const data = {};

  if (title !== undefined) {
    if (typeof title !== 'string') {
      errors.push({ field: 'title', message: journalCopy.entry.title.tooLong });
    } else if (title.trim().length > ENTRY_TITLE_MAX_LEN) {
      errors.push({ field: 'title', message: journalCopy.entry.title.tooLong });
    } else {
      data.title = title.trim();
    }
  }

  if (body !== undefined || !partial) {
    // On create the body is required. On autosave (partial) an empty body is
    // allowed: the writer clearing the textarea of a saved entry used to get a
    // validation error and a "couldn't save" banner instead of a saved change.
    if (typeof body !== 'string') {
      errors.push({ field: 'body', message: journalCopy.entry.body.empty });
    } else if (!body.trim() && !partial) {
      errors.push({ field: 'body', message: journalCopy.entry.body.empty });
    } else if (body.length > ENTRY_BODY_MAX_LEN) {
      errors.push({ field: 'body', message: journalCopy.entry.body.tooLong });
    } else {
      // keep the writer's own line breaks and leading spaces; only trim the ends
      data.body = body.replace(/\s+$/g, '');
    }
  }

  return { errors, data };
}

// ─── chat ──────────────────────────────────────────────────────────────────

const CHAT_MESSAGE_MAX_LEN = 4000; // brief 14.3: chat message 1–4,000 chars

/**
 * Validates one chat message the user is sending. `text` is required and
 * 1–4,000 chars. Returns { errors, data } with the trimmed text on success.
 * Whitespace-only counts as empty (you can't send "   ").
 */
function validateChatMessage({ text }) {
  const errors = [];
  const data = {};

  if (typeof text !== 'string' || !text.trim()) {
    errors.push({ field: 'text', message: chatCopy.message.empty });
  } else if (text.trim().length > CHAT_MESSAGE_MAX_LEN) {
    errors.push({ field: 'text', message: chatCopy.message.tooLong });
  } else {
    // keep the sender's own line breaks; only trim the ends
    data.text = text.replace(/^\s+|\s+$/g, '');
  }

  return { errors, data };
}

// The Free tier's "General chat - 30 / day" (brief §6.14) resets at midnight in
// India - the whole market is IST (brief §1), and "see you tomorrow" means the
// user's tomorrow, not the server's. We compute the day boundary as a real UTC
// instant so it doesn't depend on where the server is deployed (the same class
// of bug the age gate had). IST is a fixed +05:30 with no DST, so a constant
// offset is exact.
const IST_OFFSET_MIN = 330; // +05:30

/**
 * The current Free-chat day as real UTC instants:
 *   { start }   - most recent IST midnight (messages at/after this count today)
 *   { resetAt } - the next IST midnight (when the count rolls over)
 * @param {Date} [now]
 */
function chatDailyWindow(now = new Date()) {
  const shifted = new Date(now.getTime() + IST_OFFSET_MIN * 60000);
  const istMidnightAsUTC = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate()
  );
  const start = new Date(istMidnightAsUTC - IST_OFFSET_MIN * 60000);
  const resetAt = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, resetAt };
}

// ─── group chat (brief §6.10) ────────────────────────────────────────────────

const GROUP_MIN = 2; // §6.10 "pick 2 to N characters"
// Absolute ceiling (Ultra). The per-plan cap - 3 / 5 / 8, Free none - is
// config/plans.js group.maxMembers and is enforced in controllers/group.js.
const GROUP_MAX = 8;
const GROUP_NAME_MAX_LEN = 80;
const GROUP_SCENE_MAX_LEN = 400; // §14.3 group scene description 1–400
const GROUP_BACKSTORY_MAX_LEN = 400;

/**
 * Validates group formation / rename. On create (partial:false) `characterIds`
 * (2–5) is required. `name`, `scene`, `backstory`, and `order` are optional.
 * Returns { errors, data } with only the validated fields present.
 */
function validateGroupInput({ characterIds, name, scene, backstory, order }, { partial = false } = {}) {
  const errors = [];
  const data = {};

  if (characterIds !== undefined || !partial) {
    const ids = Array.isArray(characterIds)
      ? [...new Set(characterIds.filter((x) => typeof x === 'string' && x.trim()))]
      : null;
    if (!ids || ids.length < GROUP_MIN) {
      errors.push({ field: 'characterIds', message: groupCopy.tooFew });
    } else if (ids.length > GROUP_MAX) {
      errors.push({ field: 'characterIds', message: groupCopy.tooMany });
    } else {
      data.characterIds = ids;
    }
  }

  if (name !== undefined) {
    if (typeof name !== 'string' || name.trim().length > GROUP_NAME_MAX_LEN) {
      errors.push({ field: 'name', message: groupCopy.name.tooLong });
    } else if (name.trim()) {
      data.name = name.trim();
    }
  }

  if (scene !== undefined) {
    if (typeof scene !== 'string' || scene.trim().length > GROUP_SCENE_MAX_LEN) {
      errors.push({ field: 'scene', message: groupCopy.scene.tooLong });
    } else {
      data.scene = scene.trim();
    }
  }

  if (backstory !== undefined) {
    if (typeof backstory !== 'string' || backstory.trim().length > GROUP_BACKSTORY_MAX_LEN) {
      errors.push({ field: 'backstory', message: groupCopy.backstory.tooLong });
    } else {
      data.backstory = backstory.trim();
    }
  }

  if (order !== undefined) {
    if (Array.isArray(order)) {
      data.order = order.filter((x) => typeof x === 'string' && x.trim());
    }
  }

  return { errors, data };
}

/**
 * Validates a per-group member edit (PATCH /groups/:id/members/:characterId).
 *
 * Reuses the character field rules so a member edited inside a room obeys the
 * same limits as the builder - but writes to the *seat*, never the character.
 * Three intents are expressible:
 *
 *   { name: "Ari" }   → pin this field for this room
 *   { name: null }    → clear the override, fall back to the character
 *   { reset: true }   → clear every override on this seat
 *
 * Returns { errors, data, clear, reset } where `data` holds validated values to
 * pin and `clear` lists the fields to reset to inherited.
 */
const MEMBER_OVERRIDE_FIELDS = ['name', 'colour', 'quickLine', 'tones'];

function validateGroupMemberOverride(body = {}) {
  const reset = body.reset === true || body.reset === 'true';
  const clear = [];
  const toValidate = {};

  for (const field of MEMBER_OVERRIDE_FIELDS) {
    if (!(field in body)) continue;
    const value = body[field];
    // Explicit null / "" (for the text fields) means "stop overriding this".
    // Note tones:[] is NOT a clear - an empty list is a deliberate "no tones",
    // which the Json column can hold distinctly from NULL.
    if (value === null || (typeof value === 'string' && value.trim() === '' && field !== 'quickLine')) {
      clear.push(field);
      continue;
    }
    toValidate[field] = value;
  }

  // `partial: true` so absent fields are skipped rather than demanded. A
  // quickLine override of "" is legal (the character had a bio, this room
  // doesn't want one), which is why it's excluded from the blank-clears rule.
  const { errors, data } = validateCharacterInput(toValidate, { partial: true });

  if (!reset && clear.length === 0 && Object.keys(data).length === 0 && errors.length === 0) {
    errors.push({ field: 'member', message: '- nothing to change yet.' });
  }

  return { errors, data, clear, reset };
}

module.exports = {
  validateRegister,
  validateLoginShape,
  validateOnboarding,
  validateThemeChoice,
  validateProfileUpdate,
  validatePasswordChange,
  validateForgotPassword,
  validateResetPassword,
  validateCharacterInput,
  validateThreadInput,
  validateEntryInput,
  validateChatMessage,
  validateGroupInput,
  validateGroupMemberOverride,
  chatDailyWindow,
  isObviouslyWeak,
  parseDob,
  ageOnDate,
  EMAIL_RE,
  FREE_JOURNAL_ENTRY_LIMIT: 10, // brief 6.14: Free - Journal, 10 entries
  FREE_CHAT_DAILY_LIMIT: 30, // brief 6.14: Free - General chat, 30 / day
  CHAT_MESSAGE_MAX_LEN,
  GROUP_MIN,
  GROUP_MAX,
};
