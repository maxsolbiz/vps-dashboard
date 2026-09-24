'use strict';

// Redaction for anything served to the browser (logs, errors, process args).
// Banking apps can leak customer data, so this goes beyond tokens/emails:
// Pakistani IBANs, CNICs, phone numbers, and any run of 10+ digits.
const PATTERNS = [
  [/(\/\/)[^/@\s]+@/g, '$1***@'], // URL-embedded credentials / git remotes
  [/(bearer\s+)[A-Za-z0-9._\-~+/=]+/gi, '$1***'],
  [/((?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*)([^\s"';,}]+)/gi, '$1***'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***'],
  [/PK\d{2}[A-Z]{4}\d{16}/g, '***IBAN***'], // Pakistani IBAN
  [/\b\d{5}-\d{7}-\d\b/g, '***CNIC***'], // CNIC xxxxx-xxxxxxx-x
  [/(\+?92|0)?[- ]?3\d{2}[- ]?\d{7}\b/g, '***PHONE***'], // PK mobile
  [/\b\d{10,}\b/g, '***NUM***'] // any other long digit run (accounts, cards)
];

function redactText(s) {
  if (s == null) return s;
  let out = String(s);
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

module.exports = { redactText };
