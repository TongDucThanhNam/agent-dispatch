'use strict';
// Shared by the dispatcher and the installed bridge. No logging of prompt content.
const emailPattern = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+/gi;
function validateAllowEmails(addresses = []) {
  if (!Array.isArray(addresses) || addresses.some(address => typeof address !== 'string' ||
      address.match(emailPattern)?.[0] !== address)) throw Error('Email exceptions must be an explicit list of complete addresses.');
  return addresses;
}
function sensitiveSpans(prompt, addresses = []) {
  const allowed = new Set(validateAllowEmails(addresses).map(address => address.toLowerCase()));
  const patterns = [
    ['private-key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g],
    ['authorization', /\b(?:Proxy-)?Authorization\s*:[^\r\n]*/gi],
    ['token', /\b(?:sk-(?:proj-|ant-[A-Za-z0-9]+-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{30,}|(?:AKIA|ASIA)[A-Z0-9]{16}|hf_[A-Za-z0-9]{20,})\b/g],
    ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
    ['credential', /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*["']?\s*[:=]\s*["']?[^\s"',;}{]{8,}/gi],
    ['email', emailPattern],
  ];
  const spans = [];
  for (const [kind, pattern] of patterns) for (const match of prompt.matchAll(pattern)) {
    if (kind !== 'email' || !allowed.has(match[0].toLowerCase())) spans.push({ kind, start: match.index, end: match.index + match[0].length });
  }
  return spans.sort((a, b) => a.start - b.start || a.end - b.end);
}
function assertSafePrompt(prompt, addresses = []) {
  const spans = sensitiveSpans(prompt, addresses);
  if (spans.length) throw Error('Gemini prompt blocked: ' + spans.map(s => `${s.kind} [${s.start},${s.end}) [REDACTED]`).join('; ') +
    '. Remove secrets; --allow-email permits only explicitly listed addresses. Offsets are UTF-16 code units.');
}

const normalized = text => String(text).replace(/\r\n/g, '\n').replace(/\n+$/, '');
function matchesUserTurn(observed, prompt) {
  const text = normalized(observed), expected = normalized(prompt);
  return text === expected || ['Bạn đã nói', 'You said'].some(prefix =>
    [prefix + '\n' + expected, prefix + ' ' + expected + '\n\n' + expected,
      normalized(prefix + ' ' + prompt + '\n\n' + prompt)].includes(text));
}
const whitespace = text => text.replace(/\s+/gu, ' ').trim();
const visibleText = text => whitespace(text.replace(/^(?:Bạn đã nói|You said)\s*:?\s*/i, '')
  .replace(/(?:\s|[…]|\.{3})+(?:Show more|See more|Xem thêm|Hiển thị thêm)\s*$/i, '').replace(/(?:…|\.{3})\s*$/, ''));
function turnEvidence(observed, prompt, marker) {
  if (typeof observed !== 'string') return null;
  const sent = marker + '\n' + prompt;
  if (matchesUserTurn(observed, sent)) return 'exact';
  if (observed.includes(marker)) return 'marker';
  // Never reinterpret a different dispatch marker as a collapsed prefix.
  if (/\[ad:[a-f0-9]+\]/i.test(observed)) return null;
  const visible = visibleText(observed);
  // A short shared greeting/title is not ownership evidence.
  return visible.length >= 160 && visible.split(' ').length >= 20 && whitespace(prompt).startsWith(visible) ? 'prefix' : null;
}
function ownedTurn(before, users, prompt, marker) {
  if (users.length < before.length || before.some((user, i) => users[i]?.id !== user.id) ||
      new Set(users.map(user => user.id)).size !== users.length) throw Error('Gemini user-turn history changed.');
  const added = users.slice(before.length);
  if (added.length > 1) throw Error('Gemini user-turn ownership check failed: multiple new user turns.');
  if (!added.length || added[0].text == null || typeof added[0].text === 'string' && !added[0].text.trim()) return null;
  const level = turnEvidence(added[0].text, prompt, marker);
  if (!level) throw Error('Gemini user-turn ownership check failed.');
  return { userId: added[0].id, level };
}
const userIdPattern = /^user-query-content-[A-Za-z0-9_-]{1,160}$/;
/** DOM identity may change; only fresh content evidence can authorize rebinding. */
function createOwnershipTracker(before, prompt, marker) {
  let binding = null, missingSince = null, failed = false, rebindCount = 0;
  const observations = [];
  const observe = users => {
    const added = users.slice(before.length).map(user => ({
      userId: userIdPattern.test(user.id) ? user.id : '[invalid-id]',
      level: turnEvidence(user.text, prompt, marker) ?? 'unverified',
    }));
    // Keep transitions, not thousands of identical polls. No text, timestamps or prompt hashes.
    if (JSON.stringify(observations.at(-1)) !== JSON.stringify(added)) observations.push(added);
  };
  return {
    observe,
    get observations() { return observations; },
    get rebindCount() { return rebindCount; },
    update(users, now = Date.now()) {
      observe(users);
      if (failed) throw Error('Gemini ownership already failed; recovery cannot rebind it.');
      try {
        const owned = ownedTurn(before, users, prompt, marker);
        if (binding && !owned) missingSince ??= now;
        if (missingSince !== null && now - missingSince >= 1000) throw Error('Gemini owned user turn disappeared beyond the 1000 ms grace period.');
        if (!owned) return null; // No reply or cancellation is allowed during the gap.
        if (!userIdPattern.test(owned.userId)) throw Error('Gemini owned user-turn ID is invalid.');
        const text = visibleText(users[before.length].text);
        const rebound = !!binding && binding.userId !== owned.userId;
        const sameVisibleText = !!binding && binding.text === text;
        if (rebound && owned.level === 'prefix' && !sameVisibleText) throw Error('Gemini prefix rebinding changed the visible text.');
        if (rebound) rebindCount++;
        const transition = !binding || rebound || binding.level !== owned.level ? {
          userId: owned.userId, ownership: owned.level, rebindCount,
          ...(rebound ? { previousUserId: binding.userId, sameVisibleText } : {}),
        } : null;
        binding = { ...owned, text }; missingSince = null;
        return { ...owned, transition };
      } catch (error) { failed = true; throw error; }
    },
  };
}
module.exports = { validateAllowEmails, sensitiveSpans, assertSafePrompt, normalized, matchesUserTurn, turnEvidence, ownedTurn, createOwnershipTracker };
