// Shared response shapers - keep what goes over the wire in one place so
// no controller accidentally leaks a hash or a filesystem path.

// Private uploaded files are served from a static mount that now requires a
// live signature (lib/signedUrl.js). Minting it here, on the way out, is what
// keeps the URLs already stored in the database working: the stored value is
// the plain path, and every read re-signs it.
const { signPrivateUrl, signAttachments } = require('./signedUrl');

/**
 * User without the secrets. Beyond the password hash: `tokenVersion` is the
 * session-revocation counter (middleware/authMiddleware.js) and
 * `razorpayCustomerId` is a provider handle - neither is the client's business.
 */
function safeUser(user) {
  if (!user) return user;
  const {
    passwordHash: _hash,
    tokenVersion: _tv,
    razorpayCustomerId: _rzp,
    ...rest
  } = user;
  return rest;
}

/**
 * Character without server-side file paths. Sources keep the original
 * name/size/type (what the builder UI shows) but never `storedPath`. The plan
 * flags (isActive / isPublic / publicSlug) always ride along so the client can
 * grey out an archived character without a second request.
 */
function safeCharacter(character) {
  const { sources, ...rest } = character;
  return {
    ...rest,
    isActive: character.isActive !== false,
    isPublic: character.isPublic === true,
    publicSlug: character.publicSlug ?? null,
    sources: (sources || []).map(({ id, name, size, type, createdAt }) => ({
      id,
      name,
      size,
      type,
      createdAt,
    })),
  };
}

/**
 * The public card for a shared character (GET /api/public/characters/:slug).
 * An allow-list on purpose: never memories, sources, messages, stories, the
 * owner's id or email - a public page must not be a way into someone's chats.
 */
function publicCharacter(character) {
  if (!character) return character;
  return {
    id: character.id,
    name: character.name,
    colour: character.colour,
    avatar: character.avatar ?? null,
    quickLine: character.quickLine ?? '',
    tones: Array.isArray(character.tones) ? character.tones : [],
    publicSlug: character.publicSlug,
    createdAt: character.createdAt,
  };
}

/**
 * A journal attachment as the client renders it: never the disk path. The URL
 * is minted here (signed, short-lived) from `urlBase` + the stored filename,
 * the same way chat attachments are re-signed on every read.
 */
function safeJournalAttachment(a, urlBase) {
  if (!a) return a;
  const { attachmentUrl } = require('./journalStorage');
  return {
    id: a.id,
    kind: a.kind === 'PHOTO' ? 'photo' : 'document',
    name: a.name,
    type: a.type,
    size: a.size,
    url: signPrivateUrl(attachmentUrl(urlBase, a.storedPath)),
  };
}

/**
 * A journal entry as the client needs it. Nothing sensitive lives on an entry,
 * so this is mostly a stable-shape guarantee (and a place to hook decryption in
 * later, since the journal is meant to be encrypted at rest - brief §1).
 * `opts.urlBase` is the origin the attachment URLs are built on (the
 * controller passes PUBLIC_URL or the request origin).
 */
function safeEntry(entry, opts = {}) {
  if (!entry) return entry;
  return {
    id: entry.id,
    threadId: entry.threadId,
    title: entry.title,
    body: entry.body,
    reflection: entry.reflection ?? null,
    attachments: Array.isArray(entry.attachments)
      ? entry.attachments.map((a) => safeJournalAttachment(a, opts.urlBase))
      : [],
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

/**
 * A journal thread for the list/detail views. When `entries` is included the
 * controller can pass them through; we also surface a lightweight
 * `lastEntryPreview` and `entryCount` for the thread cards (brief §6.11) when
 * the controller computes them.
 */
function safeThread(thread, extra = {}, opts = {}) {
  if (!thread) return thread;
  const { entries } = thread;
  // Allow-list, like safeEntry - spreading the row leaked `userId` (and would
  // leak every column added to the model later).
  return {
    id: thread.id,
    name: thread.name,
    aboutRealPerson: thread.aboutRealPerson,
    colour: thread.colour,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    ...(entries ? { entries: entries.map((e) => safeEntry(e, opts)) } : {}),
    ...extra,
  };
}

/**
 * A chat message as the client renders it (brief §6.9). `sender` is lowercased
 * to the words the UI speaks ("you" / "them") so the page never has to know the
 * Prisma enum. A `blocked` character reply (c.8) keeps its row for history and
 * regenerate, but its text is withheld here - the client shows the §12.2 pause,
 * not the words the classifier stopped.
 */
function safeMessage(message) {
  if (!message) return message;
  const sender = message.sender === 'USER' ? 'you' : 'them';
  const blocked = Boolean(message.blocked);
  // a blocked character reply keeps its row but shows nothing - the client
  // renders the §12.2 pause, not the words (or picture) the classifier stopped.
  const withheld = blocked && sender === 'them';
  return {
    id: message.id,
    characterId: message.characterId,
    sender,
    text: withheld ? '' : message.text,
    // mockup 10 - a generated image + its caption ride along on a character
    // reply. Null on ordinary messages; withheld on a blocked one.
    imageUrl: withheld ? null : signPrivateUrl(message.imageUrl ?? null),
    imageAlt: withheld ? null : message.imageAlt ?? null,
    // files/photos the user shared with their message (lib/attachments.js).
    // Already free of disk paths - only { id, kind, name, type, size, url }.
    attachments: Array.isArray(message.attachments) && message.attachments.length
      ? signAttachments(message.attachments)
      : [],
    blocked,
    createdAt: message.createdAt,
  };
}

/** A memory fact for the inspector (c.11). `factKey` is internal - never sent. */
function safeMemory(memory) {
  if (!memory) return memory;
  return {
    id: memory.id,
    characterId: memory.characterId,
    fact: memory.fact,
    learnedAt: memory.learnedAt,
  };
}

// ─── group chat (brief §6.10) ──────────────────────────────────────────────────

/**
 * Resolve a seat's *effective* persona - the per-group override where one has
 * been set, otherwise the global character's value (§6.10 group details).
 *
 * This is the single place inheritance is decided. Everything that speaks for a
 * member - the room UI, the LLM persona, the denormalized senderName/senderColour
 * stamped onto a message - goes through here, so a per-group edit shows up
 * everywhere at once and still never touches the Character row.
 *
 * Returns a character-shaped object (id/name/colour/quickLine/tones) so it can
 * be handed straight to buildPersona() in lib/chat.js.
 */
function groupMemberPersona(member) {
  const c = (member && member.character) || {};
  const tones = Array.isArray(member && member.tonesOverride) ? member.tonesOverride : c.tones || [];
  return {
    id: (member && member.characterId) ?? c.id ?? null,
    name: (member && member.nameOverride) ?? c.name ?? null,
    colour: (member && member.colourOverride) ?? c.colour ?? null,
    // A seat has no photo of its own - a room can rename or re-tint a member,
    // but the face stays the character's, so this is always inherited.
    avatar: c.avatar ?? null,
    quickLine: (member && member.quickLineOverride) ?? c.quickLine ?? '',
    tones,
  };
}

/**
 * A group member (seat) for the room UI. `name`/`colour`/`quickLine`/`tones`
 * are the *effective* values, so clients that only read name/colour keep
 * working unchanged.
 *
 * `overrides` reports which fields this room has pinned (null = inherited) and
 * `original` carries the untouched character, so the details editor can offer
 * "- back to the original" without a second request.
 */
function safeGroupMember(member) {
  if (!member) return member;
  const persona = groupMemberPersona(member);
  const c = member.character || {};
  return {
    characterId: member.characterId,
    order: member.order,
    name: persona.name ?? member.name ?? null,
    colour: persona.colour ?? member.colour ?? null,
    avatar: persona.avatar ?? null,
    quickLine: persona.quickLine,
    tones: persona.tones,
    overrides: {
      name: member.nameOverride ?? null,
      colour: member.colourOverride ?? null,
      quickLine: member.quickLineOverride ?? null,
      tones: Array.isArray(member.tonesOverride) ? member.tonesOverride : null,
    },
    original: {
      name: c.name ?? null,
      colour: c.colour ?? null,
      avatar: c.avatar ?? null,
      quickLine: c.quickLine ?? '',
      tones: c.tones ?? [],
    },
  };
}

/**
 * A group message. `sender` is "you"/"them"; character lines carry the
 * denormalized senderName/senderColour so the bubble renders even if the
 * character was later deleted. A blocked reply's text is withheld (like 1:1).
 */
function safeGroupMessage(message) {
  if (!message) return message;
  const sender = message.sender === 'USER' ? 'you' : 'them';
  const blocked = Boolean(message.blocked);
  return {
    id: message.id,
    groupId: message.groupId,
    sender,
    senderCharacterId: message.senderCharacterId ?? null,
    senderName: message.senderName ?? null,
    senderColour: message.senderColour ?? null,
    text: blocked && sender === 'them' ? '' : message.text,
    // a generated picture + caption on a character line; withheld (like the
    // words) when the output classifier stopped the reply.
    imageUrl: blocked && sender === 'them' ? null : signPrivateUrl(message.imageUrl ?? null),
    imageAlt: blocked && sender === 'them' ? null : message.imageAlt ?? null,
    // photos / files the user shared with their line (lib/attachments.js)
    attachments: Array.isArray(message.attachments) && message.attachments.length
      ? signAttachments(message.attachments)
      : [],
    blocked,
    createdAt: message.createdAt,
  };
}

/** A group (room) for the list/detail views, with members and (optionally) messages. */
function safeGroup(group, extra = {}) {
  // `userId` and `turnCursor` are pulled out with the rest: this file exists so
  // nothing leaks by accident, and spreading `...rest` was quietly sending the
  // owner id and the internal rotation state to the client on every response.
  const {
    members,
    messages,
    user: _user,
    userId: _userId,
    turnCursor: _turnCursor,
    ...rest
  } = group;
  return {
    ...rest,
    ...(members ? { members: members.map(safeGroupMember) } : {}),
    ...(messages ? { messages: messages.map(safeGroupMessage) } : {}),
    ...extra,
  };
}

module.exports = {
  safeUser,
  safeCharacter,
  publicCharacter,
  safeThread,
  safeEntry,
  safeJournalAttachment,
  safeMessage,
  safeMemory,
  safeGroup,
  safeGroupMember,
  safeGroupMessage,
  groupMemberPersona,
};
