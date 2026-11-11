/**
 * lib/platform/intelligence/ai/authz/people-stopwords.ts  (Platform AI — the guard's CLOSED stop-word exemption, S2 09fl ruling 2)
 *
 * A customer whose username is an ordinary English word ("the", "show", "why") must not block every operator
 * question that uses the word. The bare-username guard (authz/people.ts guardCandidates) therefore never looks up
 * a token in this FIXED, in-code list: common English function words plus the question verbs operators use.
 * It is CLOSED on purpose — at most PEOPLE_STOP_WORDS_MAX entries (pinned in people.test.ts); it is not a
 * dictionary, so a plain-letter username ("jsmith") is still caught. Tokens are 3+ characters (shorter tokens
 * are never username-shaped), so 1–2 letter words are not listed.
 *
 * Pure and import-free.
 */

export const PEOPLE_STOP_WORDS_MAX = 300;

export const PEOPLE_STOP_WORDS: ReadonlySet<string> = new Set([
  // articles, pronouns, determiners
  "the", "this", "that", "these", "those", "there", "here", "they", "them", "their", "theirs", "she", "her", "hers", "him", "his",
  "its", "our", "ours", "your", "yours", "you", "who", "whom", "whose", "what", "which", 
  "any", "anyone", "anybody", "anything", "all", "both", "each", "either", "every", "everyone", "everybody", "everything",
  "some", "someone", "somebody", "something", "none", "nobody", "nothing", "one", "ones", "other", "others", "another",
  "such", "same", "own", 
  // prepositions, conjunctions
  "and", "but", "nor", "for", "yet", "about", "above", "across", "after", "against", "along", "among", "around", "before",
  "behind", "below", "between", "beyond", "during", "except", "from", "inside", "into", "near", "off",
  "onto", "out", "outside", "over", "past", "per", "since", "than", "through", "toward", "towards",
  "under", "until", "upon", "via", "with", "within", "without", "because", "although", "though", "unless", "whether",
  "while", "then", "also", "else", "instead", "plus", 
  // auxiliaries, common verbs
  "are", "was", "were", "been", "being", "has", "have", "had", "having", "does", "did", "doing", "done", "can", "could",
  "will", "would", "shall", "should", "may", "might", "must", "get", "gets", "got", "getting", "make", "makes", "made",
  "see", "seen", "look", "looks", "looking", "need", "needs", "want", "wants", "know", "think", "use",
  "used", "using", "happen", "happened", "happening", "change", "changed", "work", "working", "works", "fail", "failed",
  "failing", "stuck", "broke", "help", "check", "checked", "going", "goes", "come", "keep", "let", 
  // question words and question verbs
  "how", "why", "when", "where", "show", "list", "give", "tell", "find", "count", "compare",
  "explain", "summarize", "describe", "display", "open", "fetch", "search", "lookup", "sort", "rank", "filter",
  "total", "sum", "average", "trend", "break", "breakdown",
  // adverbs, quantities, time
  "not", "very", "too", "just", "only", "even", "still", "already", "again", "ever", "never", "always", "often", "sometimes",
  "now", "today", "yesterday", "tomorrow", "week", "weeks", "month", "months", "year", "years", "day", "days", "hour",
  "hours", "minute", "minutes", "last", "next", "first", "second", "third", "recent", "recently", "latest", "new", "old",
  "more", "most", "less", "least", "many", "much", "few", "several", "lot", "top", "bottom", "high",
  "higher", "highest", "low", "lower", "lowest", "big", "small", "good", "bad", "worse", "worst", "better", "best",
  "okay", "yes", "please", "thanks", "really", "like", "well", "right", "wrong", "down",
  // common nouns in operator questions
  "time", "number", "people", "way", "thing", "things", "part", "kind", "issue", "issues", "problem", "problems", "error",
  "errors", "status", "state", "health", "healthy", "data",
]);
