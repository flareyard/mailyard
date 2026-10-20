/**
 * Who a sending IP belongs to, from its reverse DNS name (HAL-3375). A best guess for people reading
 * the report: "Google" next to an IP says more than the IP. Never used to decide anything.
 */
const PROVIDERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\.google\.com$|\.googleusercontent\.com$|\.1e100\.net$/, "Google"],
  [/\.outlook\.com$|\.protection\.outlook\.com$|\.microsoft\.com$|\.hotmail\.com$/, "Microsoft"],
  [/\.cloudflare\.net$|\.cloudflare\.com$|\.cloudflare-email\.net$/, "Cloudflare"],
  [/\.amazonses\.com$|\.amazonaws\.com$/, "Amazon SES"],
  [/\.sendgrid\.net$/, "SendGrid"],
  [/\.mailgun\.net$|\.mailgun\.org$/, "Mailgun"],
  [/\.mcsv\.net$|\.mcdlv\.net$|\.rsgsv\.net$|\.mandrillapp\.com$/, "Mailchimp"],
  [/\.postmarkapp\.com$|\.mtasv\.net$/, "Postmark"],
  [/\.sparkpostmail\.com$/, "SparkPost"],
  [/\.zoho\.com$|\.zoho\.eu$/, "Zoho"],
  [/\.yahoo\.com$|\.yahoodns\.net$/, "Yahoo"],
  [/\.mimecast\.com$/, "Mimecast"],
  [/\.pphosted\.com$/, "Proofpoint"],
  [/\.messagelabs\.com$/, "Broadcom (MessageLabs)"],
  [/\.fastmail\.com$|\.messagingengine\.com$/, "Fastmail"],
  [/\.hubspotemail\.net$/, "HubSpot"],
  [/\.salesforce\.com$|\.exacttarget\.com$/, "Salesforce"],
  [/\.zendesk\.com$/, "Zendesk"],
  [/\.mailjet\.com$/, "Mailjet"],
  [/\.brevo\.com$|\.sendinblue\.com$/, "Brevo"],
]

export const providerOf = (ptr: string | null) => {
  if (!ptr) return null
  const host = ptr.toLowerCase().replace(/\.$/, "")
  for (const [pattern, name] of PROVIDERS) if (pattern.test(host)) return name
  return null
}

/** The reverse-lookup name for an IPv4 or IPv6 address, or null for anything else. */
export const reverseName = (ip: string) => {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim())
  if (v4) return `${v4[4]}.${v4[3]}.${v4[2]}.${v4[1]}.in-addr.arpa`
  if (!ip.includes(":")) return null
  const [head = "", tail = ""] = ip.trim().toLowerCase().split("::")
  const left = head ? head.split(":") : []
  const right = tail ? tail.split(":") : []
  if (left.length + right.length > 8 || [...left, ...right].some((g) => !/^[0-9a-f]{1,4}$/.test(g)))
    return null
  const groups = ip.includes("::")
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left
  if (groups.length !== 8) return null
  return `${groups
    .map((g) => g.padStart(4, "0"))
    .join("")
    .split("")
    .reverse()
    .join(".")}.ip6.arpa`
}
