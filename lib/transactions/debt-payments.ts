/**
 * lib/transactions/debt-payments.ts
 *
 * ⚠️ THIS MODULE IS GONE, deliberately, and this note stands where it was.
 *
 * It grouped debt payments by a NORMALIZED DESCRIPTOR — the payment text with
 * volatile tokens (statement dates, card last-4, ACH trace ids) stripped — and
 * used the result as the creditor key. Its own header admitted the compromise:
 * the true grouping is by liability ACCOUNT, and `counterpartyAccountId` was
 * unpopulated for debt payments (0/303 when it was written), so the descriptor
 * was the only creditor signal available.
 *
 * That is no longer true. The transfer authority now resolves an owned liability
 * counterparty for 101 of 119 counted payments, and for the remaining 18 it
 * proves the destination TYPE while refusing to name the account — because the
 * user paid two cards on the same day for the same amount, which no evidence
 * distinguishes.
 *
 * Descriptor grouping put those 18 under confident headings ("American Express
 * Ach", "Payment To Chase Card") that read as creditors and were labels. The
 * card total was right; its breakdown claimed more than the evidence carried.
 * And the same class of inference — a descriptor naming an institution — is what
 * mis-filed a $4,000 savings transfer as a card payment one slice earlier.
 *
 * Grouping now lives in `lib/transactions/debt-payment-authority.ts`, keyed on
 * the creditor ACCOUNT, with one honest bucket for creditors that cannot be
 * named. Descriptors remain visible in the ROW detail, where they are evidence
 * rather than identity.
 */

export {};
