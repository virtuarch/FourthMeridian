/**
 * lib/marketing/disposable-domains.ts  (Beta-request risk — DISPOSABLE_DOMAIN)
 *
 * A SMALL, PINNED set of disposable / throwaway e-mail domains, used ONLY as a
 * weak, advisory signal on the beta-request queue (lib/platform/growth/
 * beta-risk-core.ts). It never blocks a submission, never hides a request and
 * never changes a status — some real people use these services.
 *
 * SOURCE. Entries are drawn from the widely used open list
 *   https://github.com/disposable-email-domains/disposable-email-domains
 *   (file `disposable_email_blocklist.conf`, CC0-1.0)
 * Vendored by hand on 2026-10-31: a subset of roughly 130 of that list's most
 * common domains. It is NOT a verbatim copy of the upstream file and was not
 * diffed against it at vendoring time (no network access from the build).
 *
 * FOLLOW-UP (owner decision, BETA-REQUEST-RISK-ASSESSMENT §7.5): vendoring the
 * full upstream list, its licence record and an update cadence. Until then a
 * domain missing here simply does not raise the signal. No network lookup is
 * ever made at runtime.
 */

export const DISPOSABLE_DOMAINS_SOURCE = "https://github.com/disposable-email-domains/disposable-email-domains" as const;
export const DISPOSABLE_DOMAINS_VENDORED_AT = "2026-10-31" as const;

export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set<string>([
  // Mailinator family
  "mailinator.com", "mailinator.net", "mailinator2.com", "mailinater.com", "mailin8r.com", "notmailinator.com",
  "binkmail.com", "bobmail.info", "chammy.info", "devnullmail.com", "letthemeatspam.com", "mailismagic.com",
  "monumentmail.com", "reallymymail.com", "safetymail.info", "sendspamhere.com", "sogetthis.com",
  "spamherelots.com", "spamhereplease.com", "spamthisplease.com", "suremail.info", "thisisnotmyrealemail.com",
  "tradermail.info", "veryrealemail.com", "zippymail.info",
  // Guerrilla Mail family
  "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "guerrillamail.biz", "guerrillamail.de",
  "guerrillamail.info", "guerrillamailblock.com", "grr.la", "sharklasers.com", "pokemail.net", "spam4.me",
  // Minute / temporary inboxes
  "10minutemail.com", "10minutemail.net", "20minutemail.com", "minuteinbox.com", "temp-mail.org", "temp-mail.io",
  "tempmail.net", "tempmailo.com", "tempail.com", "tempr.email", "tempinbox.com", "tempmailaddress.com",
  "tempemail.net", "tempomail.fr", "temporaryinbox.com", "tmpmail.org", "tmpmail.net", "mytemp.email",
  "1secmail.com", "1secmail.net", "1secmail.org", "mailpoof.com", "besttempmail.com", "emltmp.com",
  "linshiyouxiang.net", "crazymailing.com",
  // YOPmail family
  "yopmail.com", "yopmail.net", "yopmail.fr", "cool.fr.nf", "jetable.fr.nf", "courriel.fr.nf",
  "moncourrier.fr.nf", "monemail.fr.nf", "monmail.fr.nf", "nospam.ze.tc", "nomail.xl.cx", "mega.zik.dj",
  "speed.1s.fr",
  // Trashmail family
  "trashmail.com", "trashmail.net", "trashmail.de", "trashmail.me", "trashmail.at", "trashmail.io",
  "trashmail.ws", "trash-mail.at", "trash-mail.com", "trash2009.com", "wegwerfmail.de", "wegwerfmail.net",
  "wegwerfmail.org", "kurzepost.de", "objectmail.com", "proxymail.eu", "rcpt.at",
  // Fake Mail Generator family
  "armyspy.com", "cuvox.de", "dayrep.com", "einrot.com", "fleckens.hu", "gustr.com", "jourrapide.com",
  "rhyta.com", "superrito.com", "teleworm.us", "fakemailgenerator.com",
  // Other common throwaway services
  "getnada.com", "nada.email", "dispostable.com", "maildrop.cc", "throwawaymail.com", "throwam.com",
  "mailnesia.com", "mailcatch.com", "mintemail.com", "mohmal.com", "emailondeck.com", "fakeinbox.com",
  "emailfake.com", "spamgourmet.com", "spambox.us", "spamex.com", "mailexpire.com", "incognitomail.org",
  "mailnull.com", "discard.email", "discardmail.com", "discardmail.de", "getairmail.com", "harakirimail.com",
  "mailforspam.com", "mailmoat.com", "meltmail.com", "burnermail.io", "inboxkitten.com", "33mail.com",
  "anonbox.net", "dodgeit.com", "e4ward.com", "gishpuppy.com", "jetable.org", "kasmail.com", "koszmail.pl",
  "spamfree24.org", "spambog.com", "spambog.de", "spambog.ru", "mail.tm",
]);

/** True when `domain` (or a parent domain of it) is on the pinned list. Case-insensitive. */
export function isDisposableDomain(domain: string, set: ReadonlySet<string> = DISPOSABLE_EMAIL_DOMAINS): boolean {
  let d = domain.trim().toLowerCase().replace(/\.$/, "");
  while (d.includes(".")) {
    if (set.has(d)) return true;
    d = d.slice(d.indexOf(".") + 1);
  }
  return false;
}
