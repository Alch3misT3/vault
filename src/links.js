'use strict';
// Turns whatever was typed ("netflix", "netflix.com", "https://…") into a
// clickable login link. Known services go straight to their sign-in page;
// anything else opens the site's home page over https.

const LOGIN_PAGES = {
  'google.com': 'https://accounts.google.com/',
  'gmail.com': 'https://accounts.google.com/',
  'youtube.com': 'https://accounts.google.com/',
  'firebase.google.com': 'https://console.firebase.google.com/',
  'microsoft.com': 'https://login.live.com/',
  'live.com': 'https://login.live.com/',
  'outlook.com': 'https://login.live.com/',
  'hotmail.com': 'https://login.live.com/',
  'xbox.com': 'https://login.live.com/',
  'office.com': 'https://login.live.com/',
  'apple.com': 'https://account.apple.com/',
  'icloud.com': 'https://www.icloud.com/',
  'facebook.com': 'https://www.facebook.com/login/',
  'instagram.com': 'https://www.instagram.com/accounts/login/',
  'x.com': 'https://x.com/i/flow/login',
  'twitter.com': 'https://x.com/i/flow/login',
  'threads.net': 'https://www.threads.net/login',
  'threads.com': 'https://www.threads.com/login',
  'tiktok.com': 'https://www.tiktok.com/login',
  'reddit.com': 'https://www.reddit.com/login/',
  'linkedin.com': 'https://www.linkedin.com/login',
  'pinterest.com': 'https://www.pinterest.com/login/',
  'snapchat.com': 'https://accounts.snapchat.com/',
  'discord.com': 'https://discord.com/login',
  'twitch.tv': 'https://www.twitch.tv/login',
  'netflix.com': 'https://www.netflix.com/login',
  'spotify.com': 'https://accounts.spotify.com/login',
  'paypal.com': 'https://www.paypal.com/signin',
  'github.com': 'https://github.com/login',
  'steampowered.com': 'https://store.steampowered.com/login/',
  'steamcommunity.com': 'https://store.steampowered.com/login/',
  'epicgames.com': 'https://www.epicgames.com/id/login',
  'riotgames.com': 'https://account.riotgames.com/',
  'leagueoflegends.com': 'https://account.riotgames.com/',
  'playvalorant.com': 'https://account.riotgames.com/',
  'battle.net': 'https://account.battle.net/',
  'dropbox.com': 'https://www.dropbox.com/login',
  'cloudflare.com': 'https://dash.cloudflare.com/login',
  'supabase.com': 'https://supabase.com/dashboard/sign-in',
  'expo.dev': 'https://expo.dev/login',
  'vercel.com': 'https://vercel.com/login',
  'figma.com': 'https://www.figma.com/login',
  'notion.so': 'https://www.notion.so/login',
  'canva.com': 'https://www.canva.com/login',
  'yahoo.com': 'https://login.yahoo.com/',
  'tuta.com': 'https://app.tuta.com/',
  'tutanota.com': 'https://app.tuta.com/',
  'proton.me': 'https://account.proton.me/login',
  'ebay.com': 'https://signin.ebay.com/',
  'chatgpt.com': 'https://chatgpt.com/auth/login',
  'openai.com': 'https://chatgpt.com/auth/login',
  'claude.ai': 'https://claude.ai/login',
  'adobe.com': 'https://account.adobe.com/',
  'zoom.us': 'https://zoom.us/signin',
  'slack.com': 'https://slack.com/signin',
  'whatsapp.com': 'https://web.whatsapp.com/',
  'telegram.org': 'https://web.telegram.org/',
};

// Plain names people type as the account title.
const NAMES = {
  google: 'google.com', gmail: 'gmail.com', youtube: 'youtube.com', firebase: 'firebase.google.com',
  microsoft: 'microsoft.com', outlook: 'outlook.com', hotmail: 'hotmail.com', xbox: 'xbox.com', office: 'office.com',
  apple: 'apple.com', 'apple id': 'apple.com', 'apple account': 'apple.com', icloud: 'icloud.com',
  facebook: 'facebook.com', instagram: 'instagram.com', x: 'x.com', twitter: 'twitter.com', threads: 'threads.com',
  tiktok: 'tiktok.com', reddit: 'reddit.com', linkedin: 'linkedin.com', pinterest: 'pinterest.com', snapchat: 'snapchat.com',
  discord: 'discord.com', twitch: 'twitch.tv', netflix: 'netflix.com', spotify: 'spotify.com', paypal: 'paypal.com',
  github: 'github.com', steam: 'steampowered.com', epic: 'epicgames.com', 'epic games': 'epicgames.com',
  riot: 'riotgames.com', 'riot games': 'riotgames.com', league: 'leagueoflegends.com', 'league of legends': 'leagueoflegends.com',
  lol: 'leagueoflegends.com', valorant: 'playvalorant.com', 'battle.net': 'battle.net', blizzard: 'battle.net',
  dropbox: 'dropbox.com', cloudflare: 'cloudflare.com', supabase: 'supabase.com', expo: 'expo.dev', vercel: 'vercel.com',
  figma: 'figma.com', notion: 'notion.so', canva: 'canva.com', yahoo: 'yahoo.com', tuta: 'tuta.com', tutanota: 'tutanota.com',
  proton: 'proton.me', 'proton mail': 'proton.me', ebay: 'ebay.com', chatgpt: 'chatgpt.com', openai: 'openai.com',
  claude: 'claude.ai', adobe: 'adobe.com', zoom: 'zoom.us', slack: 'slack.com', whatsapp: 'whatsapp.com', telegram: 'telegram.org',
  amazon: 'amazon.com', ea: 'ea.com', ubisoft: 'ubisoft.com',
};

function hostOf(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : 'https://' + raw;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
    return u;
  } catch { return null; }
}

function bareHost(hostname) {
  return hostname.toLowerCase().replace(/^www\./, '');
}

function knownLogin(hostname) {
  let h = bareHost(hostname);
  // walk up subdomains: accounts.netflix.com -> netflix.com
  while (h) {
    if (LOGIN_PAGES[h]) return LOGIN_PAGES[h];
    const i = h.indexOf('.');
    if (i < 0 || h.indexOf('.', i + 1) < 0) break;
    h = h.slice(i + 1);
  }
  return null;
}

/** Returns { url, host, known } or null. */
function loginLink(item) {
  const site = (item && item.website || '').trim();
  if (site) {
    const u = hostOf(site);
    if (!u) return null;
    const typedPath = u.pathname !== '/' || u.search;
    if (typedPath) return { url: u.href, host: bareHost(u.hostname), known: false };
    const known = knownLogin(u.hostname);
    return { url: known || u.origin + '/', host: bareHost(u.hostname), known: !!known };
  }
  const name = (item && item.title || '').trim().toLowerCase();
  if (!name) return null;
  const domain = NAMES[name] || (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(name) ? name : null);
  if (!domain) return null;
  const known = knownLogin(domain);
  return { url: known || 'https://' + domain + '/', host: bareHost(domain), known: !!known };
}

// Brand colours for the monogram tile and the colour field behind the glass.
const BRAND = {
  'netflix.com': '#d81f26', 'twitch.tv': '#8a43f5', 'discord.com': '#5865f2', 'spotify.com': '#1a9e4b',
  'github.com': '#2b3137', 'google.com': '#3d7ef0', 'gmail.com': '#d93025', 'youtube.com': '#e62117',
  'riotgames.com': '#d13639', 'leagueoflegends.com': '#c28f2c', 'playvalorant.com': '#e8434f', 'steampowered.com': '#1f4f7a',
  'paypal.com': '#0a3d91', 'cloudflare.com': '#e8711a', 'supabase.com': '#23a06b', 'instagram.com': '#d62976',
  'facebook.com': '#1877f2', 'x.com': '#1f1f23', 'twitter.com': '#1d9bf0', 'microsoft.com': '#0078d4', 'live.com': '#0078d4',
  'outlook.com': '#0f6cbd', 'xbox.com': '#107c10', 'apple.com': '#3a3a40', 'icloud.com': '#3b82f6', 'reddit.com': '#ff4500',
  'linkedin.com': '#0a66c2', 'tiktok.com': '#e6224c', 'epicgames.com': '#313131', 'amazon.com': '#e08a00', 'dropbox.com': '#0061fe',
  'figma.com': '#a259ff', 'notion.so': '#2f2f2f', 'canva.com': '#00a5b5', 'proton.me': '#6d4aff', 'tuta.com': '#d93644',
  'chatgpt.com': '#10a37f', 'openai.com': '#10a37f', 'claude.ai': '#d97757', 'vercel.com': '#1f1f1f', 'expo.dev': '#2f3542',
  'zoom.us': '#0b5cff', 'slack.com': '#611f69', 'whatsapp.com': '#1ea952', 'telegram.org': '#2aa1da', 'pinterest.com': '#e60023',
  'snapchat.com': '#e0c400', 'battle.net': '#148eff', 'adobe.com': '#e6261f', 'ebay.com': '#e53238', 'yahoo.com': '#6001d2',
};
function brandColor(item) {
  const l = loginLink(item);
  if (!l) return null;
  let h = l.host;
  while (h) {
    if (BRAND[h]) return BRAND[h];
    const i = h.indexOf('.');
    if (i < 0 || h.indexOf('.', i + 1) < 0) break;
    h = h.slice(i + 1);
  }
  return null;
}

window.loginLink = loginLink;
window.brandColor = brandColor;
window.hostOf = hostOf;
