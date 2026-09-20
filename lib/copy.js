// Every user-facing string here is copied verbatim from
// ember-content-brief.pdf, sections 4 (voice & tone), 9.1 (validation),
// and 12.3 (age gate). Controllers should import from here instead of
// inlining strings, so voice stays consistent and auditable against the doc.

const authCopy = {
  register: {
    name: {
      empty: '- a name to call you by?',
      tooLong: "- that's a lot of characters. shorten it?",
    },
    email: {
      empty: '- email, please.',
      malformed: "- that doesn't look like an email yet.",
      taken: "- there's already an account with this email. sign in instead?",
    },
    password: {
      empty: '- password, please.',
      tooShort: '- password needs at least 10 characters.',
      tooObvious: '- too obvious. mix in a number, maybe?',
    },
    dob: {
      empty: '- birth date, please.',
      invalid: "- that date doesn't look right.",
      // Absolute - no bypass, no "are you sure?" (brief, section 12.3).
      underage: 'privateaile is 18 only. - try again in a few years.',
    },
  },
  login: {
    missing: '- email and password, both.',
    noMatch: "- that email and password don't match anything we have.",
    lockedOut: '- too many tries. give it five minutes and come back.',
  },
  session: {
    signedOut: '- signed out. come back any time.',
  },
  // forgot / reset password (brief §8.3). The "requested" line is deliberately
  // generic - it's returned whether or not an account exists, so the response
  // can't be used to discover which emails are registered.
  reset: {
    requested: "- if there's an account for that email, a link is on its way.",
    linkInvalid: '- that link has expired or already been used. ask for a new one?',
    done: '- password reset. you can sign in now.',
    password: {
      empty: '- a new password, please.',
      tooShort: '- password needs at least 10 characters.',
      tooObvious: '- too obvious. mix in a number, maybe?',
    },
  },
};

const serverCopy = {
  somethingOnOurEnd: '- something on our end. we know about it.',
  rateLimited: '- a lot of messages, very fast. give it a second.',
};

// Network + full-screen system states (brief §9.2 / §9.3). The client owns
// the offline banner, slow-request timer and toast timing, but the words live
// here too so the whole of §9 is auditable against the doc in one place. The
// full-screen objects mirror src/copy.ts#serverErrorCopy exactly.
const networkCopy = {
  offline: "- you're offline. things might be quieter than usual.", // top banner
  slow: '- this is taking a moment.', // inline, after 4s
  failedMidStream: '- connection slipped. try again?', // inline bubble, Retry / Skip
  serverError: '- something on our end. we know about it.', // full screen
  rateLimited: '- a lot of messages, very fast. give it a second.', // toast
};

const serverErrorCopy = {
  notFound: {
    headline: "That page isn't here.",
    body: '- try going home. or just go back.',
  },
  serverError: {
    headline: 'Something on our end.',
    body: "- we know. we're looking. it's probably a few minutes.",
  },
  maintenance: {
    headline: "We're patching things.",
    body: '- back in a bit. follow @privateaile for updates.',
  },
  rateLimited: {
    headline: 'Slow down a moment.',
    body: '- a lot of requests, very fast. five minutes should clear it.',
  },
};

// Payment errors (brief §9.4). Razorpay-style reason codes map to these five.
const paymentCopy = {
  declined: '- that card was declined. try another? UPI usually works.',
  threeDSFailed: '- the bank check didn\'t complete. try again, or pick UPI.',
  insufficientFunds: '- not enough on the card. another method?',
  expired: "- that card's expired. add a new one?",
  generic: '- that payment didn\'t go through. nothing was charged.',
};

// Onboarding + characters copy - same rule as above: strings live here,
// verbatim from the brief where the brief has them, so controllers never
// inline user-facing text.

const onboardingCopy = {
  badChoice: "- that choice doesn't look right.",
};

const characterCopy = {
  name: {
    empty: '- give them a name first',
    tooLong: '- shorter, maybe?',
  },
  quickLine: {
    // brief 14.3: over-limit counter says "512 / 500 - shorten?"
    tooLong: '- shorten?',
  },
  tones: {
    invalid: "- those tones don't look right.",
  },
  colour: {
    invalid: "- that colour doesn't look right.",
  },
  mode: {
    invalid: '- quick or deep. those are the two.',
  },
  files: {
    tooMany: '- a few files is plenty. six at most.',
    tooBig: '- that file is a bit much. under 10mb, please.',
    badType: '- .txt, .zip, .png, .pdf - those work.',
  },
  // brief 9.5: "- this character was deleted."
  notFound: '- this character was deleted.',
};

// Journal copy - same rule: strings live here, verbatim from the brief where
// the brief has them (§6.11–6.13, §6.15 paywall, §14.3 limits).
const journalCopy = {
  thread: {
    name: {
      // "- who or what is it about?" is the field; empty gets a gentle nudge.
      empty: '- who or what is it about?',
      tooLong: '- shorter, maybe?',
    },
    // a thread the user doesn't own / that's gone
    notFound: "- that thread isn't here.",
  },
  entry: {
    title: {
      // brief 14.3: journal entry title 1–80 chars
      tooLong: '- shorter, maybe?',
    },
    body: {
      empty: '- say what you came to say.',
      tooLong: '- that ran long. trim it a little?',
    },
    notFound: "- that entry isn't here.",
  },
  // brief 6.15 paywall - Free tier gets 10 entries, then the journal opens up
  // on Plus.
  limit: 'the journal opens up on Plus. - unlimited entries.',
};

// Chat copy - the main surface (brief §6.9, the 11 states) plus the policy
// moments (§12.1–§12.2). Same rule: verbatim from the brief. The controller
// sends these; the client renders them into bubbles, banners, and the pause
// sheets. `{name}` placeholders are filled in by the controller against the
// character's name.
const chatCopy = {
  // status line beneath the name (§6.9.1) - the client owns the timing, but
  // the words live here.
  status: {
    here: '- here',
    typing: '- typing',
    quiet: '- quiet',
    tryingAgain: '- trying again', // c.6 regenerate
  },
  // c.1 / §10.2 - first message to a new character
  empty: '- this is the start. say anything.',
  // c.5 - edit a user message
  editHint: '- editing this will undo every reply after it.',
  // c.9 - network error mid-stream (client-only, but kept here for one voice)
  networkSlipped: '- connection slipped. try again?',
  // §9.5 - streaming aborted
  cutShort: '- that response was cut short.',
  // §14.3 - chat message over 4,000 chars uses the shared "{n} / 4,000 -
  // shorten?" counter shape; empty send is just ignored by the client.
  message: {
    empty: '- say something first.',
    tooLong: '- that ran long. trim it a little?',
  },
  // c.10 - daily limit hit (Free tier). Banner copy verbatim from §4.3/§6.9.
  dailyLimit: {
    banner: "30 messages - that's a lot of words. see you tomorrow? - or go Plus.",
    // §6.15 paywall variant, for the Plus sheet behind the banner.
    paywall: "you've used today's 30. - go Plus for unlimited, or wait a while.",
  },
  // c.11 / §6.9 - the memory inspector
  memory: {
    header: 'What {name} remembers',
    sub: '- only what you\'ve shared. tap any to forget.',
    empty: 'nothing yet - they\'re still getting to know you.',
    // §12/§ forget-a-memory confirm sheet
    forget: {
      headline: 'Forget this fact?',
      body: '- they won\'t remember it again.',
      confirm: 'yes, forget',
      cancel: 'keep it',
    },
    // §9.5 - memory limit reached (per character, very rare)
    limit: '- they remember a lot already. forget some old facts to make room?',
    notFound: "- that memory isn't here.",
  },
  // a message the user doesn't own / that's gone (edit, regenerate, delete)
  message_notFound: "- that message isn't here.",
  // §12.1 - moderation pause, input blocked. The character never sees it; the
  // user's draft is preserved client-side so they can rephrase.
  pause: {
    input: {
      headline: "That message can't go through.",
      body: 'our content policy doesn\'t allow it.\nyour draft is saved if you want to rephrase.',
      primary: 'edit the message',
      secondary: 'read the policy',
      tertiary: 'discard draft',
      // What each button DOES, sent alongside what it says. The client used to
      // work this out by reading the labels - `tertiary.includes('discard')`,
      // `secondary.startsWith('iCall')` - so editing a word here silently
      // changed behaviour, including breaking the helpline link.
      secondaryAction: 'policy',
      tertiaryAction: 'discardDraft',
    },
    // §12.1 - self-harm signal gets its own, gentler copy and resources.
    selfHarm: {
      headline: 'Hold on a second.',
      body:
        'if you\'re struggling, please talk to someone you trust - or iCall (India) at 9152987821 (mon–sat, 8am–10pm). there\'s no judgment here. privateaile isn\'t built for crisis support.',
      primary: 'i hear you. let me try again',
      secondary: 'iCall →',
      tertiary: 'discard draft',
      secondaryAction: 'helpline',
      tertiaryAction: 'discardDraft',
      // The number the secondary button dials, as data rather than something to
      // be parsed back out of the copy. `tel` is also shown as plain text where
      // a device can't dial.
      helpline: {
        name: 'iCall',
        tel: '9152987821',
        hours: 'mon–sat, 8am–10pm',
        region: 'India',
      },
    },
    // §12.2 - moderation pause, output blocked. The reply is kept but flagged;
    // the client shows this instead of the text. `{name}` -> character name.
    output: {
      headline: '{name} didn\'t finish that thought.',
      body: 'our content policy stopped them.\n- try asking another way?',
      primary: 'regenerate',
      secondary: 'read the policy',
      tertiary: 'close',
      secondaryAction: 'policy',
      tertiaryAction: 'close',
    },
  },
};

// Profile & account copy (settings → "profile & account", mockup screen 20).
// Same rule: strings live here, in ember's lowercase voice, so the profile
// controller never inlines user-facing text.
const profileCopy = {
  name: {
    empty: '- a name to call you by?',
    tooLong: "- that's a lot of characters. shorten it?",
  },
  email: {
    empty: '- email, please.',
    malformed: "- that doesn't look like an email yet.",
    taken: '- another account already uses this email.',
    unchanged: '- that\'s already your email.',
  },
  password: {
    // changing the password from settings - needs the current one to confirm
    currentEmpty: '- your current password, please.',
    currentWrong: "- that current password doesn't match.",
    empty: '- a new password, please.',
    tooShort: '- password needs at least 10 characters.',
    tooObvious: '- too obvious. mix in a number, maybe?',
    same: '- that\'s the same as your current one.',
    changed: '- password changed.',
  },
  avatar: {
    tooBig: '- that image is a bit much. under 5mb, please.',
    badType: '- .png, .jpg, .webp - those work for a photo.',
    missing: '- pick an image first.',
  },
  // nothing in the PATCH body we could act on
  nothingToUpdate: '- nothing to change there.',
  saved: '- saved.',
  // the account is gone (deleted while signed in)
  gone: '- that account is gone.',
};

// Group chat copy (brief §6.10). The 4-step formation UI strings live in the
// frontend page; these are the server-sent ones - validation + not-found.
const groupCopy = {
  tooFew: '- pick at least two.',
  tooMany: '- five at most.',
  name: { tooLong: '- shorter, maybe?' },
  scene: { tooLong: '- that ran long. under 400 characters?' },
  backstory: { tooLong: '- one line is plenty. trim it?' },
  notFound: "- that group isn't here.",
  missingCharacters: '- one of those characters isn\'t here anymore.',
  // group details (§6.10) - editing one member, in this room only
  memberNotFound: "- they're not in this room.",
  memberSaved: '- just for this room.',
  memberReset: '- back to the original.',
  // §8.4 - group chat is a roleplay feature; past the trial it closes.
  trialEnded: '- rooms were part of the trial. - go Plus to keep them?',
  // editing the cast of an existing room (§6.10)
  alreadyIn: "- they're already in this room.",
  lastTwo: '- a room needs two. remove it instead?',
  memberRemoved: '- they left the room.',
  memberAdded: '- they joined the room.',
  reordered: '- new order saved.',
};

// ─── §12.6 reporting a character / response ──────────────────────────────────
// The more-menu → "Report this" sheet. The radio labels and the toasts live
// here; the client owns the sheet chrome. Reasons map to the ReportReason enum.
const reportCopy = {
  headline: "Tell us what's off.",
  sub: '- we read these. a real person does.',
  reasons: {
    IMPERSONATION: 'they impersonated a real person',
    SEXUAL: 'sexual content',
    VIOLENCE: 'violence or harm',
    PRETENDED_HUMAN: 'they pretended to be human',
    OTHER: 'something else',
  },
  notePlaceholder: 'anything else worth knowing?',
  send: 'Send report',
  cancel: 'cancel',
  // toast after a successful submit (brief §12.6)
  sent: '- thank you. we\'ll look at it.',
  // a reason the client sent that isn't one of the five
  invalidReason: '- pick what fits best.',
  notFound: "- that message isn't here.",
};

// ─── §12.5 account deletion (30-day grace) ───────────────────────────────────
const deletionCopy = {
  // step 1 - the initial confirm modal
  confirm: {
    headline: 'Delete everything?',
    body:
      'your account, your characters, your journal, your conversations. a 30-day grace period - sign back in any time before that and it all comes back. after 30 days, nothing recovers.',
    primary: 'start deletion',
    cancel: 'keep my account',
  },
  // step 2 - type-to-confirm
  typeToConfirm: {
    headline: 'One last check.',
    body: '- type delete my account below to confirm.',
    phrase: 'delete my account',
    confirm: 'Confirm',
  },
  // step 3 - the final full-screen state. `{date}` -> the grace-end date.
  done: {
    headline: 'Gone.',
    body:
      'your account is scheduled for deletion in 30 days. sign in any time before {date} to undo it. after that, every trace of it is removed. take care.',
    close: 'Close',
  },
  // the type-to-confirm phrase didn't match
  phraseMismatch: '- that didn\'t match.',
  // the account is already scheduled / already gone
  alreadyScheduled: '- this account is already on its way out.',
};

// ─── §12.7 data export ───────────────────────────────────────────────────────
const exportCopy = {
  // step 1 - confirm
  confirm: {
    headline: 'All yours.',
    body:
      "we'll pack your account into a JSON file - characters, conversations, journal, settings. ready in five minutes, usually. we'll email you when it's done.",
    button: 'Generate export',
  },
  // step 2 - toast after requesting
  requested: '- packing it up. we\'ll email you.',
  // the link inside the ready-email is good for 7 days
  linkExpired: '- that export link has expired. ask for a fresh one from settings.',
};

module.exports = {
  authCopy,
  serverCopy,
  networkCopy,
  serverErrorCopy,
  paymentCopy,
  onboardingCopy,
  characterCopy,
  journalCopy,
  chatCopy,
  groupCopy,
  profileCopy,
  reportCopy,
  deletionCopy,
  exportCopy,
};
