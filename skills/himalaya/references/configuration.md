# Himalaya Configuration Reference

Configuration file location: `~/.config/himalaya/config.toml`

> **Compatibility:** This guide follows the **Himalaya v2.1.0+** config schema. If you are on an older version, run `himalaya --version` and upgrade if needed.

## Minimal IMAP + SMTP Setup

```toml
[accounts.default]
email = "user@example.com"
display-name = "Your Name"
default = true

# IMAP backend for reading emails
imap.server = "imaps://imap.example.com:993"
imap.sasl.plain.username = "user@example.com"
imap.sasl.plain.password.raw = "your-password"

# SMTP backend for sending emails
smtp.server = "smtp://smtp.example.com:587"
smtp.starttls = true
smtp.sasl.plain.username = "user@example.com"
smtp.sasl.plain.password.raw = "your-password"
```

**Schema notes (v2.1.0):**
- `imap.server` / `smtp.server` are URLs: `imaps://` (implicit TLS), `imap://` (cleartext, optionally upgraded via STARTTLS), `smtps://` (implicit TLS), `smtp://` (STARTTLS).
- Authentication is under `*.sasl.plain.*`. Other SASL mechanisms (`oauthbearer`, `xoauth2`, `scram-sha-256`) are also supported.

## Password Options

### Raw password (testing only, not recommended)

```toml
imap.sasl.plain.password.raw = "your-password"
smtp.sasl.plain.password.raw = "your-password"
```

### Password from command (recommended)

```toml
imap.sasl.plain.password.command = "pass show email/imap"
smtp.sasl.plain.password.command = "pass show email/smtp"
# imap.sasl.plain.password.command = "security find-generic-password -a user@example.com -s imap -w"
```

### System keyring (requires keyring feature)

```toml
imap.sasl.plain.password.keyring = "imap-example"
```

Then run `himalaya account configure <account>` to store the password.

## Gmail Configuration

```toml
[accounts.gmail]
email = "you@gmail.com"
display-name = "Your Name"
default = true

imap.server = "imaps://imap.gmail.com:993"
imap.sasl.plain.username = "you@gmail.com"
imap.sasl.plain.password.command = "pass show google/app-password"

smtp.server = "smtp://smtp.gmail.com:587"
smtp.starttls = true
smtp.sasl.plain.username = "you@gmail.com"
smtp.sasl.plain.password.command = "pass show google/app-password"
```

**Note:** Gmail requires an App Password if 2FA is enabled.

## iCloud Configuration

```toml
[accounts.icloud]
email = "you@icloud.com"
display-name = "Your Name"

imap.server = "imaps://imap.mail.me.com:993"
imap.sasl.plain.username = "you@icloud.com"
imap.sasl.plain.password.command = "pass show icloud/app-password"

smtp.server = "smtp://smtp.mail.me.com:587"
smtp.starttls = true
smtp.sasl.plain.username = "you@icloud.com"
smtp.sasl.plain.password.command = "pass show icloud/app-password"
```

**Note:** Generate an app-specific password at appleid.apple.com

## Folder Aliases

Map custom folder names:

```toml
[accounts.default]
mailbox.alias.inbox = "INBOX"
mailbox.alias.sent = "Sent"
mailbox.alias.drafts = "Drafts"
mailbox.alias.trash = "Trash"
```

## Multiple Accounts

```toml
[accounts.personal]
email = "personal@example.com"
default = true
# ... backend config ...

[accounts.work]
email = "work@company.com"
# ... backend config ...
```

Switch accounts with `--account`:

```bash
himalaya --account work envelope list
```

## Notmuch Backend (local mail)

```toml
[accounts.local]
email = "user@example.com"

notmuch.db-path = "~/.mail/.notmuch"
```

## OAuth2 Authentication (for providers that support it)

```toml
[accounts.gmail-oauth]
email = "you@gmail.com"

imap.server = "imaps://imap.gmail.com:993"
imap.sasl.xoauth2.username = "you@gmail.com"
imap.sasl.xoauth2.token.raw = "your-access-token"
# Or use a command: imap.sasl.xoauth2.token.command = ["pass", "show", "gmail/xoauth2-token"]

smtp.server = "smtp://smtp.gmail.com:587"
smtp.starttls = true
smtp.sasl.xoauth2.username = "you@gmail.com"
smtp.sasl.xoauth2.token.raw = "your-access-token"
```

**Note:** For XOAUTH2 you need a valid access token; token refresh is the caller's responsibility. The `oauth2` auth type from pre-2.1.0 has been replaced by the SASL mechanism tables above.

## Additional Options

### Signature

```toml
[accounts.default]
signature = "Best regards,\nYour Name"
signature-delim = "-- \n"
```

### Downloads directory

```toml
[accounts.default]
downloads-dir = "~/Downloads/himalaya"
```

### Editor for composing

Set via environment variable:

```bash
export EDITOR="vim"
```
