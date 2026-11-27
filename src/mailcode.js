'use strict';
// Finds a one-time code in an email ("Your verification code is 482 913"), for the big Copy button.
// Used by the main process when a message arrives. Returns the code (spaces/dashes removed) or null.

(function () {
  const WORDS = /(code|verif|one[- ]?time|otp|passcode|pin\b|security|confirm|login|sign[- ]?in|2fa|two[- ]factor|token|код|парола|потвър)/i;
  const NOT_NEAR = /(order|invoice|tracking|phone|tel|zip|postal|account (number|no)|amount|total|price|€|\$|£|лв)/i;

  function candidates(text) {
    const out = [];
    const re = /(?<![\w.,\/:#+-])(\d{3}[ -]\d{3}|\d{4,8}|[A-Z0-9]{6,8})(?![\w.,\/:-]*\w)/g;
    let m;
    while ((m = re.exec(text))) {
      const raw = m[1];
      const code = raw.replace(/[ -]/g, '');
      if (/^[A-Z]+$/.test(code)) continue;                       // a word in capitals
      if (/[A-Z]/.test(code) && !/\d/.test(code)) continue;
      if (/^(19|20)\d{2}$/.test(code)) continue;                  // a year
      out.push({ code, at: m.index, len: raw.length });
    }
    return out;
  }

  function findCode(subject, text) {
    const subj = String(subject || '');
    const body = String(text || '').slice(0, 20000);
    let best = null;
    const subjectSaysCode = WORDS.test(subj);
    for (const [src, weight] of [[subj, 3], [body, 1]]) {
      for (const c of candidates(src)) {
        const before = src.slice(Math.max(0, c.at - 90), c.at);
        const after = src.slice(c.at + c.len, c.at + c.len + 40);
        let score = 0;
        if (WORDS.test(before)) score += 4;
        if (WORDS.test(after)) score += 1;
        if (src === subj && subjectSaysCode) score += 2;
        if (src === body && subjectSaysCode) score += 3; // "Your code" in the subject, the code in the text
        if (NOT_NEAR.test(before.slice(-40))) score -= 5;
        if (/^\d{6}$/.test(c.code)) score += 1;
        score *= weight;
        if (score >= 4 && (!best || score > best.score)) best = { code: c.code, score };
      }
    }
    return best ? best.code : null;
  }

  const root = typeof window !== 'undefined' ? window : module.exports;
  root.findMailCode = findCode;
})();
