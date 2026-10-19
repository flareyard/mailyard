# Security

Please report vulnerabilities privately, not in a public issue. Use GitHub's private vulnerability reporting on this repository: **Security → Report a vulnerability**. We answer within three working days and agree a fix and disclosure date with you.

Mailyard holds people's mail, contact lists and sending reputation. The reports that matter most:

- reading or sending mail without access;
- getting around a scope, role or mailbox membership;
- sign-in, sessions, OAuth for MCP clients, and the Flareyard sign-in hand-off;
- secrets at rest (webhook secrets, the push key, the claim link);
- tracking or unsubscribe links that can be forged.

Please don't run tests against someone else's deployment. Deploy your own (`bun run deploy`) and test that.
