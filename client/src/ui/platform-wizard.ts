/**
 * Platform Wizard — extracted from scene.ts so it can be used from both
 * the in-world mailbox interaction and the settings modal.
 *
 * All modals are pure DOM (no Phaser dependency).
 */

import {
  PLATFORM_CATALOG,
  PLATFORM_CREDENTIAL_FIELDS,
  getPlatformEntry,
  type PlatformConnectionState,
  type PlatformEvent,
} from "../../../shared/types";

// ── Static data ──────────────────────────────────────────────────────────────

/** Mapping of platform names to icon URLs for logo display. */
export const PLATFORM_ICON_SLUGS: Record<string, string> = {
  Slack: "https://cdn.jsdelivr.net/npm/simple-icons@15/icons/slack.svg",
  Discord: "discord",
  Telegram: "telegram",
  WhatsApp: "whatsapp",
  Signal: "signal",
  Email: "gmail",
  SMS: "https://cdn.jsdelivr.net/npm/simple-icons@15/icons/twilio.svg",
  "Microsoft Teams": "https://cdn.jsdelivr.net/npm/simple-icons@12/icons/microsoftteams.svg",
  "Google Chat": "googlechat",
  Matrix: "matrix",
  Mattermost: "mattermost",
  LINE: "line",
  BlueBubbles: "imessage",
  ntfy: "ntfy",
  SimpleX: "simplex",
  "Home Assistant": "homeassistant",
  "Teams Meetings": "https://cdn.jsdelivr.net/npm/simple-icons@12/icons/microsoftteams.svg",
  "MS Graph Webhook": "https://cdn.jsdelivr.net/npm/simple-icons@12/icons/microsoftteams.svg",
  QQ: "qq",
};

/** Get a logo img element for a platform, or null if no icon is available. */
export function platformLogoImg(platform: string, size: number): HTMLImageElement | null {
  const iconRef = PLATFORM_ICON_SLUGS[platform];
  if (!iconRef) return null;
  const img = document.createElement("img");
  img.src = iconRef.startsWith("http") ? iconRef : `https://cdn.simpleicons.org/${iconRef}`;
  img.alt = platform;
  img.style.cssText = `width:${size}px;height:${size}px;flex-shrink:0;object-fit:contain;`;
  img.onerror = () => { img.style.display = "none"; };
  return img;
}

/** Security warnings for platforms that handle sensitive data or have broad access. */
export const PLATFORM_SECURITY_WARNINGS: Record<string, { level: "low" | "medium" | "high"; note: string }> = {
  Slack: {
    level: "medium",
    note: "The bot token grants access to channel messages where the bot is invited. Only invite the bot to channels where agents should read. Use the minimum required scopes.",
  },
  Discord: {
    level: "medium",
    note: "The bot can read all server messages it has access to. Restrict bot roles to specific channels. Enable only the Message Content Intent if needed.",
  },
  WhatsApp: {
    level: "medium",
    note: "Twilio credentials can send messages on your behalf. Keep your Auth Token private and rotate it if compromised.",
  },
  Gmail: {
    level: "high",
    note: "Google OAuth grants access to your email. Hermes can read and send emails. Consider using a dedicated Google account for agent communications.",
  },
  "Google Chat": {
    level: "medium",
    note: "The service account can read and post messages in Google Chat spaces. Restrict the service account to specific spaces.",
  },
  "Microsoft Teams": {
    level: "medium",
    note: "Azure AD app credentials grant access to Teams channels. Limit the app to specific teams and channels via admin consent policies.",
  },
  "GitHub Issues": {
    level: "medium",
    note: "The GitHub token grants access to your repositories. Use a fine-grained PAT scoped to specific repos with minimum permissions.",
  },
  "X (Twitter)": {
    level: "high",
    note: "X API credentials can post tweets and read your account data. Use a dedicated account or restrict API permissions to read-only if possible.",
  },
  Telegram: {
    level: "low",
    note: "The bot token only allows the bot to receive messages sent to it directly. No access to your private conversations.",
  },
};

/** Platform-specific setup steps for the connect modal. */
export const PLATFORM_SETUP_STEPS: Record<string, { title: string; body: string; cmd?: string }[]> = {
  Slack: [
    {
      title: "Slack — Create a Slack App",
      body: `1. Go to https://api.slack.com/apps\n2. Click "Create New App" → "From scratch"\n3. Name it (e.g. "Agent Heights Bot")\n4. Pick your workspace → Create App`,
    },
    {
      title: "Slack — Add Bot Scopes",
      body: `1. Left sidebar → "OAuth & Permissions"\n2. Under "Bot Token Scopes" add:\n   - chat:write\n   - channels:history\n   - channels:read\n   - groups:history\n   - groups:read\n   - im:history\n   - im:write\n   - mpim:history`,
    },
    {
      title: "Slack — Install & Copy Tokens",
      body: `1. Click "Install to Workspace" at the top\n2. Authorize the app\n3. Copy the "Bot User OAuth Token"\n   (starts with xoxb-)\n4. Go to Basic Information →\n   App-Level Tokens → Generate Token\n   with scope connections:write\n   (starts with xapp-)`,
    },
    {
      title: "Slack — Invite Bot to Channels",
      body: `In Slack, invite your bot to any channel\nwhere agents should receive messages:\n\n  /invite @Agent Heights Bot\n\nOnce done, interact with the Slack mailbox\nagain to check messages.`,
    },
  ],
  Discord: [
    {
      title: "Discord — Create Application",
      body: `1. Go to https://discord.com/developers/applications\n2. Click "New Application"\n3. Name it (e.g. "Agent Heights") → Create`,
    },
    {
      title: "Discord — Add a Bot",
      body: `1. Left sidebar → "Bot"\n2. Click "Add Bot" → Yes, do it!\n3. Under "Privileged Gateway Intents" enable:\n   - Message Content Intent\n   - Server Members Intent\n4. Click "Save Changes"`,
    },
    {
      title: "Discord — Copy Bot Token",
      body: `1. Still on the Bot page, click\n   "Reset Token" (or "Copy" if visible)\n2. Copy the token — store it safely,\n   it won't be shown again`,
    },
    {
      title: "Discord — Invite Bot to Server",
      body: `1. Left sidebar → "OAuth2" → "URL Generator"\n2. Under Scopes check: bot\n3. Under Bot Permissions check:\n   - Send Messages\n   - Read Message History\n4. Open the generated URL in your browser\n5. Select your server → Authorize`,
    },
  ],
  Telegram: [
    {
      title: "Telegram — Create a Bot",
      body: `1. Open Telegram and message @BotFather\n2. Send: /newbot\n3. Give it a name (e.g. "Agent Heights")\n4. Give it a username ending in "bot"\n   (e.g. "agent_heights_bot")`,
    },
    {
      title: "Telegram — Copy Bot Token",
      body: `BotFather will respond with an HTTP API\ntoken that looks like:\n\n  123456789:ABCdefGHIjklMNOpqrSTUvwxYZ\n\nCopy this token — you'll need it below.`,
    },
  ],
  WhatsApp: [
    {
      title: "WhatsApp — Set Up Twilio",
      body: `WhatsApp Business API requires a provider.\nTwilio is the easiest:\n\n1. Sign up at https://www.twilio.com\n2. Navigate to Messaging → WhatsApp\n3. Activate the WhatsApp sandbox (free)\n   or apply for production access`,
    },
    {
      title: "WhatsApp — Copy Credentials",
      body: `From the Twilio console, copy:\n   - Account SID (starts with AC...)\n   - Auth Token\n   - Your WhatsApp number\n     (sandbox: +14155238886)`,
    },
  ],
  Signal: [
    {
      title: "Signal — Register a Number",
      body: `Signal requires a dedicated phone number\nregistered via signal-cli.\n\n1. Install signal-cli on your server:\n     sudo apt install signal-cli\n2. Register a number:\n     signal-cli -u +15551234567 register\n3. Verify with the SMS code:\n     signal-cli -u +15551234567 verify 123-456`,
      cmd: "signal-cli -u +15551234567 register",
    },
  ],
  Email: [
    {
      title: "Email — Create an App Password",
      body: `Hermes connects via IMAP/SMTP.\n\nFor Gmail:\n1. Enable 2-Step Verification\n2. Go to https://myaccount.google.com/apppasswords\n3. Generate an app password for "Mail"\n4. Copy the 16-character password\n\nFor other providers, use your IMAP/SMTP\ncredentials directly.`,
    },
    {
      title: "Email — Note IMAP/SMTP Settings",
      body: `You'll need:\n   - IMAP server (e.g. imap.gmail.com)\n   - IMAP port (usually 993, SSL)\n   - SMTP server (e.g. smtp.gmail.com)\n   - SMTP port (usually 587, TLS)\n   - Email address\n   - App password`,
    },
  ],
  SMS: [
    {
      title: "SMS — Set Up Twilio",
      body: `SMS messaging uses Twilio as the\nprovider.\n\n1. Sign up at https://www.twilio.com\n2. Navigate to Phone Numbers\n3. Buy or claim a phone number\n   (trial numbers work for testing)`,
    },
    {
      title: "SMS — Copy Credentials",
      body: `From the Twilio console, copy:\n   - Account SID (starts with AC...)\n   - Auth Token\n   - Your Twilio phone number\n     (e.g. +15551234567)\n\nMake sure the number has SMS\ncapabilities enabled.`,
    },
  ],
  "Microsoft Teams": [
    {
      title: "Teams — Register an App",
      body: `1. Go to https://entra.microsoft.com\n   (Microsoft Entra ID, formerly Azure AD)\n2. App registrations → New registration\n3. Name it (e.g. "Agent Heights Bot")\n4. Supported account types:\n   "Single tenant" is fine for most\n5. Click Register`,
    },
    {
      title: "Teams — Create a Bot",
      body: `1. Go to https://dev.teams.microsoft.com/bots\n2. Click "New Bot"\n3. Name it and select your tenant\n4. Copy the Bot ID (App ID)\n5. Generate a client secret and copy it\n   (this is your Bot Password)`,
    },
    {
      title: "Teams — Copy Credentials",
      body: `You'll need three values:\n   - App (Bot) ID — from the bot portal\n   - Tenant ID — from Entra ID overview\n   - Bot Password — the client secret\n   you generated\n\nKeep these safe — you'll enter them\nin the next step.`,
    },
  ],
  "Google Chat": [
    {
      title: "Google Chat — Create a Project",
      body: `1. Go to https://console.cloud.google.com\n2. Create a new project\n   (e.g. "agent-heights-chat")\n3. Enable the Google Chat API\n   from the API Library`,
    },
    {
      title: "Google Chat — Create a Service Account",
      body: `1. IAM & Admin → Service Accounts\n2. Create a service account\n3. Grant it the Chat API scope\n4. Create a JSON key and download it\n\nThe JSON file contains your\nproject_id and service account\ncredentials.`,
    },
    {
      title: "Google Chat — Configure the App",
      body: `1. Go to the Chat API configuration page\n2. Set up your bot app:\n   - Name: "Agent Heights"\n   - Avatar URL (optional)\n   - Functionality: Bot\n3. Add the service account email\n   as an authorized user\n4. Copy the Project ID and the\n   full service account JSON`,
    },
  ],
  Matrix: [
    {
      title: "Matrix — Choose a Homeserver",
      body: `Matrix is a federated protocol — you\nneed a homeserver account.\n\nOptions:\n   - matrix.org (free, public)\n   - self-host (e.g. Synapse, Dendrite)\n   -EMS (Element Matrix Services)\n\nCreate an account for your bot.`,
    },
    {
      title: "Matrix — Get an Access Token",
      body: `1. Log in to your homeserver as the bot\n   account (via Element or curl)\n2. Get the access token from\n   Settings → Help & About → Access Token\n   (in Element desktop)\n\nOr via API:\n   curl -XPOST https://matrix.org/_matrix/client/v3/login\n     -d '{"type":"m.login.password",\n          "identifier":{"type":"m.id.user",\n          "user":"botname"},\n          "password":"..."}'`,
    },
    {
      title: "Matrix — Copy Credentials",
      body: `You'll need:\n   - Homeserver URL\n     (e.g. https://matrix.org)\n   - Access Token (starts with syt_...)\n   - User ID (e.g. @bot:matrix.org)\n\nMake sure the bot is invited to\nany rooms where agents should\nreceive messages.`,
    },
  ],
  Mattermost: [
    {
      title: "Mattermost — Set Up Your Server",
      body: `Mattermost is self-hosted chat.\n\n1. Install Mattermost or use an\n   existing server\n2. Create a bot account:\n   System Console → Bot Accounts\n   (enable if needed)\n3. Integrations → Bot Accounts\n   → Create Bot`,
    },
    {
      title: "Mattermost — Copy Credentials",
      body: `You'll need:\n   - Server URL (e.g. https://chat.example.com)\n   - Bot Token (from the bot account)\n   - Team Name (e.g. "engineering")\n\nInvite the bot to channels where\nagents should receive messages.`,
    },
  ],
  LINE: [
    {
      title: "LINE — Create a Provider",
      body: `1. Go to https://developers.line.biz\n2. Log in with a LINE account\n3. Create a Provider\n4. Create a Messaging API channel\n5. Name it (e.g. "Agent Heights")`,
    },
    {
      title: "LINE — Copy Credentials",
      body: `From the channel settings page:\n   - Channel Access Token\n     (issue via "Issue" button)\n   - Channel Secret\n   (found under "Channel secret")\n\nConfigure your webhook URL to point\nto your Hermes gateway.`,
    },
  ],
  IRC: [
    {
      title: "IRC — Choose a Network",
      body: `IRC is a classic chat protocol.\n\n1. Pick an IRC network\n   (e.g. irc.libera.chat, irc.oftc.net)\n2. Register a nickname for your bot\n   via NickServ\n3. Note the server address and port\n   (usually 6697 for TLS)`,
    },
    {
      title: "IRC — Identify Channels",
      body: `List the channels the bot should join\nand monitor, e.g.:\n   #general, #support, #dev\n\nMake sure the bot nickname is\nregistered and identified with\nNickServ so it can join restricted\nchannels.`,
    },
  ],
  BlueBubbles: [
    {
      title: "BlueBubbles — Install the Server",
      body: `BlueBubbles lets you send/receive\niMessage programmatically.\n\n1. You need a Mac that's always on\n2. Download BlueBubbles Server\n   from https://bluebubbles.app\n3. Install and launch the server\n4. Follow the setup wizard to connect\n   your iMessage account`,
    },
    {
      title: "BlueBubbles — Copy Credentials",
      body: `From the BlueBubbles Server UI:\n   - Server URL (e.g. http://192.168.1.100:1234)\n   - Password (set during setup)\n\nMake sure the server is accessible\nfrom your Hermes gateway host.`,
    },
  ],
  ntfy: [
    {
      title: "ntfy — Choose a Server",
      body: `ntfy is a simple push notification\nservice.\n\n1. Use the public server at\n   https://ntfy.sh (free)\n   or self-host your own\n2. Pick a topic name for your agents\n   (e.g. "agent-heights-msgs")\n3. Subscribe to the topic in the\n   ntfy app on your phone`,
    },
    {
      title: "ntfy — Copy Credentials",
      body: `You'll need:\n   - Server URL (e.g. https://ntfy.sh)\n   - Topic name\n\nNo authentication needed for the\npublic server. For self-hosted,\nadd an access token if configured.`,
    },
  ],
  SimpleX: [
    {
      title: "SimpleX — Set Up via Hermes",
      body: `SimpleX Chat is a privacy-focused\nmessaging platform with no user IDs.\n\nConfiguration is handled by Hermes\nAgent directly — no credential entry\nneeded in this modal.\n\nRun on your server:\n  hermes gateway setup simplex\n\nFollow the prompts to create an\nSMP address and share it with\ncontacts who should message your\nagents.`,
    },
  ],
  "Open WebUI": [
    {
      title: "Open WebUI — Set Up Your Instance",
      body: `Open WebUI is a self-hosted AI\nfrontend compatible with OpenAI APIs.\n\n1. Install Open WebUI\n   (https://github.com/open-webui/open-webui)\n2. Create an admin account\n3. Generate an API key from\n   Settings → API Keys`,
    },
    {
      title: "Open WebUI — Copy Credentials",
      body: `You'll need:\n   - Server URL (e.g. http://localhost:3000)\n   - API Key\n\nMake sure your Hermes gateway can\nreach the Open WebUI instance.`,
    },
  ],
  Webhooks: [
    {
      title: "Webhooks — Configure Your Endpoint",
      body: `The webhook adapter sends and\nreceives messages via HTTP POST.\n\n1. Set up an endpoint URL that can\n   receive POST requests with JSON\n   body containing message data\n2. Optionally set a shared secret\n   for HMAC signature verification\n3. Make sure the URL is reachable\n   from your Hermes gateway`,
    },
  ],
  DingTalk: [
    {
      title: "DingTalk — Create an App",
      body: `DingTalk is Alibaba's workplace\nmessaging platform.\n\n1. Go to https://open-dev.dingtalk.com\n2. Create an enterprise app\n3. Enable robot (bot) capability\n4. Configure message receiving mode\n   (HTTP or Stream)`,
    },
    {
      title: "DingTalk — Copy Credentials",
      body: `From the app management page:\n   - App Key\n   - App Secret\n\nConfigure the message callback URL\nto point to your Hermes gateway.`,
    },
  ],
  "Feishu/Lark": [
    {
      title: "Feishu/Lark — Create an App",
      body: `Feishu (China) / Lark (international)\nis ByteDance's workplace platform.\n\n1. Go to https://open.feishu.cn\n   (or https://open.larksuite.com)\n2. Create an enterprise app\n3. Enable the bot capability\n4. Add message receiving permissions`,
    },
    {
      title: "Feishu/Lark — Copy Credentials",
      body: `From the app credentials page:\n   - App ID (starts with cli_...)\n   - App Secret\n\nConfigure the event subscription URL\nto point to your Hermes gateway.`,
    },
  ],
  WeCom: [
    {
      title: "WeCom — Create an App",
      body: `WeCom (WeChat Work) is Tencent's\nenterprise messaging platform.\n\n1. Go to https://work.weixin.qq.com\n2. Navigate to App Management\n3. Create a custom app\n4. Enable the bot/receiving message\n   capability`,
    },
    {
      title: "WeCom — Copy Credentials",
      body: `You'll need:\n   - Corp ID (from admin console)\n   - Agent ID (from the app)\n   - Secret (from the app)\n\nConfigure the callback URL to point\nto your Hermes gateway.`,
    },
  ],
  "WeCom Callback": [
    {
      title: "WeCom Callback — Set Up",
      body: `WeCom callback mode receives\nmessages via webhook.\n\n1. In WeCom admin console, go to\n   your app → Receive Messages\n2. Set the callback URL to your\n   Hermes gateway endpoint\n3. Set a Token and Encoding AES Key\n   (generate or let WeCom provide)`,
    },
    {
      title: "WeCom Callback — Copy Credentials",
      body: `You'll need:\n   - Token\n   - Encoding AES Key\n   - Corp ID\n\nThese are used to verify and\ndecrypt incoming webhook payloads.`,
    },
  ],
  Weixin: [
    {
      title: "Weixin — Set Up iLink Bot",
      body: `WeChat (personal) can be bridged\nvia the iLink Bot API.\n\n1. Contact iLink to get a bot token\n   (https://www.ilink.com)\n2. The bot will manage a WeChat\n   account on your behalf\n3. Configure message forwarding to\n   your Hermes gateway`,
    },
  ],
  QQ: [
    {
      title: "QQ — Create a Bot",
      body: `QQ Bot uses Tencent's official\nBot API v2.\n\n1. Go to https://q.qq.com\n2. Register as a developer\n3. Create a bot application\n4. Configure the message receiving\n   endpoint`,
    },
    {
      title: "QQ — Copy Credentials",
      body: `From the bot management page:\n   - App ID\n   - Token\n\nConfigure the webhook URL to point\nto your Hermes gateway.`,
    },
  ],
  Yuanbao: [
    {
      title: "Yuanbao — Set Up via Hermes",
      body: `Yuanbao is Tencent's AI chat\nplatform with DM and group chat.\n\nConfiguration is handled by Hermes\nAgent directly — no credential entry\nneeded in this modal.\n\nRun on your server:\n  hermes gateway setup yuanbao\n\nFollow the prompts to authenticate\nand configure your Yuanbao account.`,
    },
  ],
  "Home Assistant": [
    {
      title: "Home Assistant — Enable Conversation",
      body: `Home Assistant has a built-in\nconversation integration.\n\n1. Go to https://www.home-assistant.io\n   to install if needed\n2. In HA, go to Settings →\n   Devices & Services → Add\n   Integration → Conversation\n3. Enable the conversation API`,
    },
    {
      title: "Home Assistant — Create a Token",
      body: `1. In HA, go to your profile\n   (bottom left)\n2. Scroll to "Long-Lived Access Tokens"\n3. Create a token named "Hermes"\n4. Copy the token\n\nYou'll also need your HA URL\n(e.g. http://homeassistant.local:8123)`,
    },
  ],
  "Teams Meetings": [
    {
      title: "Teams Meetings — Register an App",
      body: `Teams Meetings bot requires a\nMicrosoft Bot Framework app.\n\n1. Go to https://entra.microsoft.com\n2. App registrations → New registration\n3. Name it (e.g. "Agent Heights Meetings")\n4. Single tenant is fine for most\n5. Click Register`,
    },
    {
      title: "Teams Meetings — Configure Bot",
      body: `1. Go to https://dev.teams.microsoft.com/bots\n2. Create a new bot\n3. Enable "Calling" and "Meeting"\n   capabilities\n4. Copy the Bot ID (App ID)\n5. Generate a client secret`,
    },
    {
      title: "Teams Meetings — Copy Credentials",
      body: `You'll need:\n   - App (Bot) ID\n   - Tenant ID\n   - Bot Password (client secret)\n\nThe bot will join scheduled\nmeetings and can transcribe/\nrespond to meeting chat.`,
    },
  ],
  "MS Graph Webhook": [
    {
      title: "MS Graph — Register an App",
      body: `Microsoft Graph webhooks receive\nchange notifications for Teams and\nOutlook messages.\n\n1. Go to https://entra.microsoft.com\n2. App registrations → New registration\n3. Add API permissions:\n   - ChannelMessage.Read.All\n   - Mail.Read\n4. Grant admin consent`,
    },
    {
      title: "MS Graph — Create Subscription",
      body: `1. Create a client secret for your app\n2. Use the Graph API to create a\n   subscription:\n   POST /subscriptions\n   with your notification URL\n3. The notification URL must point\nto your Hermes gateway endpoint`,
    },
    {
      title: "MS Graph — Copy Credentials",
      body: `You'll need:\n   - Client (App) ID\n   - Client Secret\n   - Tenant ID\n\nThese are used to obtain access\ntokens for calling the Graph API\nand managing subscriptions.`,
    },
  ],
  Raft: [
    {
      title: "Raft — Set Up via Hermes",
      body: `Raft is a messaging platform\nintegrated through Hermes Agent.\n\nConfiguration is handled by Hermes\nAgent directly — no credential entry\nneeded in this modal.\n\nRun on your server:\n  hermes gateway setup raft\n\nFollow the prompts to configure\nyour Raft connection.`,
    },
  ],
};

// ── Types ────────────────────────────────────────────────────────────────────

export interface PlatformWizardCallbacks {
  /** Send a WS message */
  send: (msg: object) => void;
  /** Register a config result listener */
  onConfigResult: (fn: (platform: string, success: boolean, error?: string) => void) => void;
  /** Unregister a config result listener */
  offConfigResult: (fn: (platform: string, success: boolean, error?: string) => void) => void;
  /** Called when the wizard is closed */
  onClose?: () => void;
  /** Platform connection states (for showing connected/not-connected status) */
  platformStates: PlatformConnectionState[];
  /** Called when messages are received (for check messages flow) */
  onMailboxMessages?: (fn: (platform: string, events: PlatformEvent[]) => void) => void;
  offMailboxMessages?: (fn: (platform: string, events: PlatformEvent[]) => void) => void;
  /** Called to show a conversation modal (scene-specific) */
  onShowConversation?: (platform: string, events: PlatformEvent[]) => void;
  /** Optional toast function */
  toast?: (msg: string) => void;
}

// ── Wizard modal ─────────────────────────────────────────────────────────────

/** Show a multi-step modal walking the user through platform setup with credential input. */
export function showPlatformConnectModal(
  platform: string,
  callbacks: PlatformWizardCallbacks,
): void {
  const state = callbacks.platformStates.find((s) => s.platform === platform);
  const gatewayRunning = state?.gatewayRunning ?? false;

  const instructionSteps = PLATFORM_SETUP_STEPS[platform] ?? [];
  const credFields = PLATFORM_CREDENTIAL_FIELDS[platform] ?? [];
  const totalSteps = instructionSteps.length + 1;

  const overlay = document.createElement("div");
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    background: rgba(0,0,0,0.55); z-index: 10000;
    display: flex; align-items: center; justify-content: center;
    font-family: 'M PLUS Rounded 1c', system-ui, sans-serif;
  `;

  const card = document.createElement("div");
  card.style.cssText = `
    background: #f5f0e6; border: 3px solid #d4c5a9; border-radius: 16px;
    width: 520px; max-height: 90vh; display: flex; flex-direction: column;
    box-shadow: 0 12px 48px rgba(0,0,0,0.3); overflow: hidden;
  `;

  const header = document.createElement("div");
  header.style.cssText = `
    background: #e8dcc8; border-bottom: 2px solid #d4c5a9;
    padding: 16px 24px; display: flex; align-items: center; gap: 12px;
    flex-shrink: 0;
  `;
  const connectLogoSlug = PLATFORM_ICON_SLUGS[platform];
  const connectLogoHtml = connectLogoSlug
    ? `<img src="https://cdn.simpleicons.org/${connectLogoSlug}" alt="${platform}" style="width:28px;height:28px;flex-shrink:0;object-fit:contain;" onerror="this.parentElement.innerHTML='✉'">`
    : `<span style="font-size:28px;">✉</span>`;
  header.innerHTML = `
    ${connectLogoHtml}
    <span style="font-size:20px;font-weight:bold;color:#3d3528;flex:1;">${platform} Mailbox</span>
    <span style="font-size:13px;font-weight:bold;color:${gatewayRunning ? "#4a9b4a" : "#b07050"};">
      ${gatewayRunning ? "● Connected" : "○ Not connected"}
    </span>
  `;
  card.appendChild(header);

  const content = document.createElement("div");
  content.style.cssText = `
    padding: 24px 30px; flex: 1; overflow-y: auto;
    display: flex; flex-direction: column; gap: 0;
  `;
  card.appendChild(content);

  const secWarn = PLATFORM_SECURITY_WARNINGS[platform];
  if (secWarn) {
    const warnBanner = document.createElement("div");
    const isHigh = secWarn.level === "high";
    const isMed = secWarn.level === "medium";
    warnBanner.style.cssText = `
      display: flex; gap: 8px; padding: 10px 14px; border-radius: 8px;
      margin-bottom: 16px; font-size: 12px; line-height: 1.5;
      background: ${isHigh ? "#fdf0ec" : isMed ? "#fef9ec" : "#eef5ee"};
      border: 1px solid ${isHigh ? "#e8a895" : isMed ? "#e8d895" : "#c8d8c8"};
      color: ${isHigh ? "#a04020" : isMed ? "#8a7020" : "#4a6a4a"};
    `;
    const iconColor = isHigh ? "#c44a30" : isMed ? "#c8a030" : "#5a8a5a";
    warnBanner.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${iconColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:2px;"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      <div>
        <div style="font-weight:bold;margin-bottom:2px;">Security Note</div>
        <div>${secWarn.note}</div>
      </div>
    `;
    content.appendChild(warnBanner);
  }

  const stepBadge = document.createElement("div");
  stepBadge.style.cssText = `
    display: inline-block; background: #8b7355; color: #fff;
    font-size: 12px; font-weight: bold; padding: 4px 12px;
    border-radius: 12px; margin-bottom: 16px; align-self: flex-start;
  `;
  content.appendChild(stepBadge);

  const titleEl = document.createElement("div");
  titleEl.style.cssText = "font-size:17px;font-weight:bold;color:#3d3528;margin-bottom:16px;line-height:1.3;";
  content.appendChild(titleEl);

  const bodyEl = document.createElement("div");
  bodyEl.style.cssText = "font-size:14px;color:#6b5d4a;line-height:1.8;white-space:pre-wrap;margin-bottom:20px;";
  content.appendChild(bodyEl);

  const cmdBox = document.createElement("div");
  cmdBox.style.cssText = `
    background: #3d3528; color: #e8dcc8; font-family: monospace;
    font-size: 13px; padding: 10px 16px; border-radius: 8px;
    border: 1px solid #8b7355; margin-bottom: 20px; display: none;
  `;
  content.appendChild(cmdBox);

  const formContainer = document.createElement("div");
  formContainer.style.cssText = "display:none;flex-direction:column;gap:18px;";

  const formSubtitle = document.createElement("div");
  formSubtitle.textContent = `Write your ${platform} credentials on the envelope:`;
  formSubtitle.style.cssText = "font-size:14px;color:#6b5d4a;margin-bottom:4px;";
  formContainer.appendChild(formSubtitle);

  const inputs: HTMLInputElement[] = [];
  for (const field of credFields) {
    const wrapper = document.createElement("div");
    wrapper.style.cssText = "display:flex;flex-direction:column;gap:6px;";

    const label = document.createElement("div");
    label.textContent = field.label;
    label.style.cssText = "font-size:12px;font-weight:600;color:#8b7355;";

    const input = document.createElement("input");
    input.type = field.type;
    input.placeholder = field.placeholder;
    input.dataset.key = field.key;
    input.style.cssText = `
      width: 100%; padding: 10px 14px; background: #fffcf5;
      border: 2px solid #d4c5a9; border-radius: 8px;
      color: #3d3528; font-size: 14px; font-family: monospace;
      box-sizing: border-box; outline: none; transition: border-color 0.2s;
    `;
    input.addEventListener("focus", () => { input.style.borderColor = "#8b7355"; });
    input.addEventListener("blur", () => { input.style.borderColor = "#d4c5a9"; });

    wrapper.appendChild(label);
    wrapper.appendChild(input);
    formContainer.appendChild(wrapper);
    inputs.push(input);
  }

  const resultMsg = document.createElement("div");
  resultMsg.style.cssText = "font-size:13px;min-height:22px;text-align:center;color:#6b5d4a;";
  formContainer.appendChild(resultMsg);

  content.appendChild(formContainer);

  const footer = document.createElement("div");
  footer.style.cssText = `
    padding: 16px 24px; border-top: 2px solid #d4c5a9;
    display: flex; flex-direction: column; align-items: center; gap: 12px;
    flex-shrink: 0;
  `;

  const dotsContainer = document.createElement("div");
  dotsContainer.style.cssText = "display:flex;gap:10px;";
  const dotEls: HTMLSpanElement[] = [];
  for (let i = 0; i < totalSteps; i++) {
    const dot = document.createElement("span");
    dot.textContent = "○";
    dot.style.cssText = "font-size:16px;color:#c4b89a;";
    dotsContainer.appendChild(dot);
    dotEls.push(dot);
  }
  footer.appendChild(dotsContainer);

  const btnRow = document.createElement("div");
  btnRow.style.cssText = "display:flex;gap:20px;align-items:center;";

  const makeBtn = (label: string, color: string) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.style.cssText = `
      background: none; border: none; font-size: 15px; font-weight: bold;
      color: ${color}; cursor: pointer; font-family: inherit;
      padding: 4px 8px;
    `;
    return btn;
  };

  const prevBtn = makeBtn("‹ Back", "#8b7355");
  const nextBtn = makeBtn("Next ›", "#8b7355");
  const submitBtn = makeBtn("Send ✉", "#4a9b4a");
  const closeBtn = makeBtn("Close", "#b07050");

  btnRow.appendChild(prevBtn);
  btnRow.appendChild(nextBtn);
  btnRow.appendChild(submitBtn);
  btnRow.appendChild(closeBtn);
  footer.appendChild(btnRow);

  card.appendChild(footer);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  let currentStep = 0;
  let submitting = false;

  const renderStep = () => {
    const isCredStep = currentStep === instructionSteps.length;
    const stepNum = currentStep + 1;

    stepBadge.textContent = `Step ${stepNum} of ${totalSteps}`;

    if (isCredStep) {
      titleEl.textContent = "Enter Credentials";
      bodyEl.textContent = "";
      cmdBox.style.display = "none";
      formContainer.style.display = "flex";
      resultMsg.textContent = "";
    } else {
      const step = instructionSteps[currentStep];
      titleEl.textContent = step.title;
      bodyEl.innerHTML = step.body.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener" style="color:#6c5ce7;text-decoration:underline;">$1</a>');
      formContainer.style.display = "none";
      if (step.cmd) {
        cmdBox.style.display = "block";
        cmdBox.textContent = `$ ${step.cmd}`;
      } else {
        cmdBox.style.display = "none";
      }
    }

    for (let i = 0; i < dotEls.length; i++) {
      dotEls[i].textContent = i === currentStep ? "●" : i < currentStep ? "✓" : "○";
      dotEls[i].style.color = i < currentStep ? "#4a9b4a" : i === currentStep ? "#8b7355" : "#c4b89a";
    }

    prevBtn.style.display = currentStep > 0 ? "" : "none";
    nextBtn.style.display = (!isCredStep && currentStep < totalSteps - 1) ? "" : "none";
    submitBtn.style.display = (isCredStep && !submitting) ? "" : "none";
  };

  prevBtn.onclick = () => { if (currentStep > 0) { currentStep--; renderStep(); } };
  nextBtn.onclick = () => { if (currentStep < totalSteps - 1) { currentStep++; renderStep(); } };

  const onConfigResult = (respPlatform: string, success: boolean, error?: string) => {
    if (respPlatform !== platform || !submitting) return;
    submitting = false;
    if (success) {
      resultMsg.style.color = "#4a9b4a";
      resultMsg.textContent = "✓ Envelope sealed! Your mailbox is now connected.";
      submitBtn.style.display = "";
      submitBtn.textContent = "Done ✓";
      submitBtn.onclick = closeModal;
    } else {
      resultMsg.style.color = "#b07050";
      resultMsg.textContent = `✗ ${error ?? "Could not deliver. Try again."}`;
      submitBtn.style.display = "";
      submitBtn.textContent = "Send ✉";
    }
  };
  callbacks.onConfigResult(onConfigResult);

  submitBtn.onclick = () => {
    if (submitting) return;
    const credentials: Record<string, string> = {};
    let missing = false;
    for (const input of inputs) {
      const val = input.value.trim();
      if (!val) {
        missing = true;
        input.style.borderColor = "#b07050";
      } else {
        input.style.borderColor = "#d4c5a9";
        credentials[input.dataset.key!] = val;
      }
    }
    if (missing) {
      resultMsg.style.color = "#b07050";
      resultMsg.textContent = "Please fill in all fields on the envelope.";
      return;
    }

    submitting = true;
    submitBtn.style.display = "none";
    resultMsg.style.color = "#6b5d4a";
    resultMsg.textContent = "Delivering...";
    callbacks.send({ type: "configure_platform", platform, credentials });
  };

  const closeModal = () => {
    callbacks.offConfigResult(onConfigResult);
    overlay.remove();
    callbacks.onClose?.();
  };
  closeBtn.onclick = closeModal;
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });

  renderStep();
}

// ── Platform picker modal ────────────────────────────────────────────────────

export interface PlatformPickerCallbacks {
  send: (msg: object) => void;
  /** Currently assigned platform names (to grey them out) */
  assignedPlatforms: Set<string>;
  /** Slot index (for mailbox assignment) — null for settings (no slot) */
  slot: number | null;
  /** Called when a platform is selected */
  onSelect?: (platform: string) => void;
  /** Called when the picker is closed */
  onClose?: () => void;
}

/** Show a scrollable platform picker modal for choosing a platform. */
export function showPlatformPickerModal(callbacks: PlatformPickerCallbacks): void {
  const { assignedPlatforms: assigned, slot } = callbacks;

  const overlay = document.createElement("div");
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    background: rgba(0,0,0,0.55); z-index: 10000;
    display: flex; align-items: center; justify-content: center;
    font-family: 'M PLUS Rounded 1c', system-ui, sans-serif;
  `;

  const card = document.createElement("div");
  card.style.cssText = `
    background: #f5f0e6; border: 3px solid #d4c5a9; border-radius: 16px;
    width: 480px; max-height: 80vh; display: flex; flex-direction: column;
    box-shadow: 0 12px 48px rgba(0,0,0,0.3); overflow: hidden;
  `;

  const header = document.createElement("div");
  header.style.cssText = `
    background: #e8dcc8; border-bottom: 2px solid #d4c5a9;
    padding: 16px 24px; display: flex; align-items: center; gap: 12px;
    flex-shrink: 0;
  `;
  header.innerHTML = `
    <span style="font-size:28px;">✉</span>
    <span style="font-size:20px;font-weight:bold;color:#3d3528;flex:1;">${slot !== null ? `Mailbox ${slot + 1} — ` : ""}Choose Platform</span>
  `;
  card.appendChild(header);

  const list = document.createElement("div");
  list.style.cssText = `
    padding: 12px 16px; flex: 1; overflow-y: auto;
    display: flex; flex-direction: column; gap: 6px;
  `;
  card.appendChild(list);

  const tierLabels: Record<number, string> = { 1: "Popular", 2: "Available", 3: "Regional / Niche" };
  let lastTier = 0;

  for (const entry of PLATFORM_CATALOG) {
    if (entry.tier !== lastTier) {
      lastTier = entry.tier;
      const tierHeader = document.createElement("div");
      tierHeader.textContent = tierLabels[entry.tier] ?? "Other";
      tierHeader.style.cssText = `
        font-size: 12px; font-weight: bold; color: #8b7355;
        text-transform: uppercase; letter-spacing: 1px;
        margin: 12px 0 4px 0; padding-bottom: 4px;
        border-bottom: 1px solid #d4c5a9;
      `;
      if (entry.tier === 1) tierHeader.style.marginTop = "0";
      list.appendChild(tierHeader);
    }

    const isAssigned = assigned.has(entry.name);
    const item = document.createElement("div");
    item.style.cssText = `
      display: flex; align-items: center; gap: 12px; padding: 10px 14px;
      background: ${isAssigned ? "#e0d8c8" : "#fffcf5"};
      border: 2px solid #d4c5a9; border-radius: 10px;
      cursor: ${isAssigned ? "not-allowed" : "pointer"};
      transition: border-color 0.2s, background 0.2s;
      opacity: ${isAssigned ? "0.5" : "1"};
    `;
    if (!isAssigned) {
      item.addEventListener("mouseenter", () => { item.style.borderColor = "#8b7355"; });
      item.addEventListener("mouseleave", () => { item.style.borderColor = "#d4c5a9"; });
    }

    const logo = platformLogoImg(entry.name, 24);
    if (logo) {
      item.appendChild(logo);
    } else {
      const colorDot = document.createElement("div");
      colorDot.style.cssText = `
        width: 24px; height: 24px; border-radius: 6px; flex-shrink: 0;
        background: #${entry.color.toString(16).padStart(6, "0")};
        border: 2px solid rgba(0,0,0,0.15);
      `;
      item.appendChild(colorDot);
    }

    const textCol = document.createElement("div");
    textCol.style.cssText = "flex:1;display:flex;flex-direction:column;";
    const nameEl = document.createElement("div");
    nameEl.textContent = entry.name + (isAssigned ? " (in use)" : "");
    nameEl.style.cssText = "font-size:15px;font-weight:bold;color:#3d3528;";
    const descEl = document.createElement("div");
    descEl.textContent = entry.description;
    descEl.style.cssText = "font-size:12px;color:#8b7355;";
    textCol.appendChild(nameEl);
    textCol.appendChild(descEl);
    item.appendChild(textCol);

    if (!isAssigned) {
      item.onclick = () => {
        if (slot !== null) {
          callbacks.send({ type: "set_mailbox_platform", slot, platform: entry.name });
        }
        callbacks.onSelect?.(entry.name);
        overlay.remove();
      };
    }

    list.appendChild(item);
  }

  if (slot !== null) {
    const unassignBtn = document.createElement("button");
    unassignBtn.textContent = "Unassign this mailbox";
    unassignBtn.style.cssText = `
      margin: 12px 16px; padding: 10px; background: none; border: 2px solid #b07050;
      border-radius: 8px; color: #b07050; font-size: 14px; font-weight: bold;
      cursor: pointer; font-family: inherit; flex-shrink: 0;
    `;
    unassignBtn.onclick = () => {
      callbacks.send({ type: "set_mailbox_platform", slot, platform: null });
      overlay.remove();
    };
    card.appendChild(unassignBtn);
  }

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "Close";
  closeBtn.style.cssText = `
    margin: 0 16px 16px; padding: 10px; background: none; border: 2px solid #8b7355;
    border-radius: 8px; color: #8b7355; font-size: 14px; font-weight: bold;
    cursor: pointer; font-family: inherit; flex-shrink: 0;
  `;
  closeBtn.onclick = () => { overlay.remove(); callbacks.onClose?.(); };
  card.appendChild(closeBtn);

  overlay.appendChild(card);
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) { overlay.remove(); callbacks.onClose?.(); } });
}

// ── Mailbox action modal ─────────────────────────────────────────────────────

export interface MailboxActionCallbacks {
  send: (msg: object) => void;
  platformStates: PlatformConnectionState[];
  onConfigResult: (fn: (platform: string, success: boolean, error?: string) => void) => void;
  offConfigResult: (fn: (platform: string, success: boolean, error?: string) => void) => void;
  onMailboxMessages: (fn: (platform: string, events: PlatformEvent[]) => void) => void;
  offMailboxMessages: (fn: (platform: string, events: PlatformEvent[]) => void) => void;
  onShowConversation?: (platform: string, events: PlatformEvent[]) => void;
  onShowConnectWizard?: (platform: string) => void;
  onShowPicker?: (slotIndex: number) => void;
  toast?: (msg: string) => void;
  /** For timeout handling (scene uses Phaser timer, settings uses setTimeout) */
  setTimeout: (fn: () => void, ms: number) => () => void;
}

/** Show a small action menu for an assigned mailbox: check, configure, change, or unassign. */
export function showMailboxActionModal(
  platform: string,
  slotIndex: number,
  connected: boolean,
  callbacks: MailboxActionCallbacks,
): void {
  const overlay = document.createElement("div");
  overlay.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
    background: rgba(0,0,0,0.55); z-index: 10000;
    display: flex; align-items: center; justify-content: center;
    font-family: 'M PLUS Rounded 1c', system-ui, sans-serif;
  `;

  const card = document.createElement("div");
  card.style.cssText = `
    background: #f5f0e6; border: 3px solid #d4c5a9; border-radius: 16px;
    width: 360px; box-shadow: 0 12px 48px rgba(0,0,0,0.3); overflow: hidden;
  `;

  const header = document.createElement("div");
  header.style.cssText = `
    background: #e8dcc8; border-bottom: 2px solid #d4c5a9;
    padding: 16px 24px; display: flex; align-items: center; gap: 12px;
  `;
  const entry = getPlatformEntry(platform);
  const colorHex = entry ? "#" + entry.color.toString(16).padStart(6, "0") : "#888";
  const logoSlug = PLATFORM_ICON_SLUGS[platform];
  const logoHtml = logoSlug
    ? `<img src="https://cdn.simpleicons.org/${logoSlug}" alt="${platform}" style="width:20px;height:20px;flex-shrink:0;object-fit:contain;" onerror="this.style.display='none'">`
    : `<span style="width:20px;height:20px;border-radius:5px;background:${colorHex};border:2px solid rgba(0,0,0,0.15);flex-shrink:0;"></span>`;
  header.innerHTML = `
    ${logoHtml}
    <span style="font-size:18px;font-weight:bold;color:#3d3528;flex:1;">${platform} Mailbox</span>
    <span style="font-size:13px;font-weight:bold;color:${connected ? "#4a9b4a" : "#b07050"};">
      ${connected ? "● Connected" : "○ Not connected"}
    </span>
  `;
  card.appendChild(header);

  const body = document.createElement("div");
  body.style.cssText = "padding: 16px 20px; display: flex; flex-direction: column; gap: 10px;";

  const makeBtn = (label: string, color: string, onclick: () => void) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.style.cssText = `
      padding: 12px 16px; border: 2px solid ${color}; border-radius: 10px;
      background: none; color: ${color}; font-size: 15px; font-weight: bold;
      cursor: pointer; font-family: inherit; text-align: left;
      transition: background 0.2s;
    `;
    btn.addEventListener("mouseenter", () => { btn.style.background = `${color}15`; });
    btn.addEventListener("mouseleave", () => { btn.style.background = "none"; });
    btn.onclick = onclick;
    return btn;
  };

  if (connected) {
    body.appendChild(makeBtn("📬 Check Messages", "#4a9b4a", () => {
      overlay.remove();
      callbacks.send({ type: "check_mailbox", platform });
      let responded = false;
      const cancelTimeout = callbacks.setTimeout(() => {
        if (!responded) {
          responded = true;
          callbacks.toast?.(`[${platform}] No response from server. Make sure you're in your office.`);
        }
      }, 2000);
      const onMessages = (respPlatform: string, events: PlatformEvent[]) => {
        if (responded || respPlatform !== platform) return;
        responded = true;
        cancelTimeout();
        callbacks.offMailboxMessages(onMessages);
        if (events.length === 0) {
          callbacks.toast?.(`[${platform}] No messages.`);
          return;
        }
        callbacks.onShowConversation?.(platform, events);
      };
      callbacks.onMailboxMessages(onMessages);
    }));
  } else {
    body.appendChild(makeBtn("⚙ Set Up / Configure", "#8b7355", () => {
      overlay.remove();
      callbacks.onShowConnectWizard?.(platform);
      callbacks.send({ type: "connect_platform", platform });
    }));
  }

  body.appendChild(makeBtn("🔄 Change Platform", "#6c5ce7", () => {
    overlay.remove();
    callbacks.onShowPicker?.(slotIndex);
  }));

  body.appendChild(makeBtn("✕ Unassign Mailbox", "#b07050", () => {
    callbacks.send({ type: "set_mailbox_platform", slot: slotIndex, platform: null });
    overlay.remove();
  }));

  card.appendChild(body);

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "Close";
  closeBtn.style.cssText = `
    margin: 0 20px 16px; padding: 8px; background: none; border: 2px solid #8b7355;
    border-radius: 8px; color: #8b7355; font-size: 13px; font-weight: bold;
    cursor: pointer; font-family: inherit;
  `;
  closeBtn.onclick = () => overlay.remove();
  card.appendChild(closeBtn);

  overlay.appendChild(card);
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
}
