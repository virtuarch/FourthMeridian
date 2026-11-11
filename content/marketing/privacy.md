*Effective November 2, 2026.*

This Privacy Policy explains what information Fourth Meridian (the "Service") collects, how we use it, and the choices you have. Fourth Meridian is currently offered as a closed, invite-only beta.

Our guiding principle is minimalism: we keep no more than we need to run the Service, and we never sell your data.

## 1. Information we collect

- **Account information.** The email address, username and name you register with, your password (stored only as a hash), your date of birth if you provide it (stored encrypted), and the two-factor authentication secret and recovery codes if you enable them.
- **Financial information.** Data from accounts you choose to link through Plaid (balances, transactions and, where you consent, investment holdings), and any assets, debts, wallets, notes, interest rates or minimum payments you add manually.
- **What you ask the AI to remember.** Goals, planned expenses, rules and planning figures you state in Conversations, stored per person and per Space (see our [AI Disclosures](/legal/ai)).
- **Security and audit records.** Sign-ins (including failed attempts), password and two-factor changes, connection changes, data exports and account changes, with the IP address and browser user-agent of the request.
- **Operational records.** For each AI model call and each connection refresh, technical facts such as which account and Space it was for, timing, token counts, and whether it succeeded or failed — never the content of a conversation or a financial figure.
- **Product usage.** First-party usage events recorded on our own servers — for example that you viewed a Space, started or left the bank-connection flow, completed a first sync, or that an AI answer failed — limited to identifiers, dates and fixed categories. They never include financial values or conversation content, are not shared with any analytics provider, and are deleted after 13 months.

## 2. How we use your information

- To provide the Service: aggregating your accounts into a single view, computing net worth, cash flow and history, generating your Daily Brief, and answering your questions in Conversations.
- To secure your account: authentication, two-factor verification, rate limiting, and audit logging of sensitive actions.
- To operate the Service: monitoring reliability and cost from the operational records above.
- To communicate with you about the Service, including beta access and security notices.

We do not sell your personal information, and we do not use your financial data to advertise to you.

## 3. Linked financial accounts

Linked bank and brokerage accounts are connected through Plaid. You choose the institution in Plaid Link and Plaid asks for your consent there. Fourth Meridian requests read access to balances and transactions and, only where you consent, to investment holdings. Fourth Meridian cannot move money, make payments or change anything at your institution. The access tokens Plaid issues are encrypted at rest (AES-256-GCM) and are never shown or exported.

You can disconnect a connection at any time. Disconnecting stops syncing, removes the accounts from your Spaces, and revokes Fourth Meridian's access at Plaid when nothing else uses the connection. The history already imported is kept — not deleted — until you delete your account, and reconnecting restores the same accounts. Plaid's own privacy policy governs Plaid's handling of your data.

## 4. AI processing

The Daily Brief and Conversations send relevant portions of your financial context to OpenAI's API for processing. See our [AI Disclosures](/legal/ai) for exactly what is sent, what is never sent, what Fourth Meridian remembers, and the limits of AI-generated output.

### Operator tools and AI

<!-- DRAFT (owner decision D3) — wording, including the AI-provider retention paragraph, still pending owner approval. The "Last updated" date (LEGAL.privacy.updated in copy.ts) and the "Effective" line above are left unchanged; the owner updates them on publish. -->

When our staff use AI-assisted tools, it is to help our support and operations team understand problems with accounts and connections, such as why a bank connection stopped syncing. Only authorized staff can use them, and daily spending limits cap their use.

What is sent to the AI provider is technical facts such as status and error codes, counts, times, the name of your financial institution, and the stage of your account setup, with coded references (pseudonymous identifiers) instead of your name or email, plus the question the staff member asks. Our tools do not include your name, email address or username in what they send to the AI provider, and staff are instructed not to type them into questions. Nor do they include your account balances or other amounts from your accounts, or any message or other text written by you or your financial institution.

When these tools show your name, email address or username to authorized support staff, it appears only on their screen and the view is recorded.

Staff conversations with these tools expire after 7 days, and the tools keep no memory between conversations. Records of staff access are kept for security purposes.

Our AI provider, OpenAI, does not use this information to train its models under its API terms, and we have not opted in to any data sharing. We do not ask OpenAI to store these requests. Under its current API data policy, OpenAI may keep them for up to 30 days to monitor for abuse before deleting them, unless the law requires it to keep them longer or it is needed to protect against harm.

## 5. Sharing

We share information only with service providers who help us operate the Service — Plaid for financial-data connectivity, OpenAI for AI processing, and our hosting, database, email-delivery and error-monitoring providers — and only as needed to provide it. We may disclose information if required by law.

## 6. Data retention

We retain your data for as long as your account is active.

When you delete your account, deletion is scheduled **7 days** later. During those 7 days your account is locked, and you can cancel by signing back in and choosing "Cancel deletion". When the window ends, your account, your personal Space, your accounts, transactions, holdings and memory are permanently deleted, and Fourth Meridian revokes its access to your linked accounts at Plaid. If a revocation cannot be confirmed, deletion may be held for up to three further days while it is retried, after which it completes regardless.

Accounts that belong to a Space you share with others — rather than to you — remain in that Space after your account is deleted; your connection to them is removed. If you are the only owner of a shared Space that still has other members, you must transfer ownership or delete that Space before deleting your account.

After deletion we retain security and audit records in anonymised form (no longer linked to any account; your email appears only as a one-way hash in the deletion record) and operational records whose identifiers no longer resolve to any account, together with any records we are required to keep by law.

## 7. Your choices

- **Access and export.** You can download a full copy of your data from within the Service as a ZIP file containing a manifest, your data as JSON, and CSV files for the tabular sets. Exports are limited to three per day; transactions are capped at the newest 5,000 rows, and the manifest says so when the cap applied.
- **Deletion.** You can delete your account at any time, subject to the 7-day window described above.
- **Disconnection.** You can disconnect any linked account at any time.
- **AI memory.** You can edit or delete what the AI remembers in the Memory panel.
- **Two-factor.** You can enable and manage two-factor authentication at any time.

## 8. Security

We use encryption, hashing of credentials, least-privilege read-only access to linked accounts, and audit logging. No system is perfectly secure, but protecting your data is a first-order priority — see our [security page](/security) for details.

## 9. Changes to this Policy

We may update this Policy as the Service evolves. Material changes will be communicated through the Service.

## 10. Contact

Questions about this Policy, or requests regarding your data, can be sent to [support@fourthmeridian.com](mailto:support@fourthmeridian.com).
