/**
 * DMARC aggregate reports in the shapes Google and Microsoft send (HAL-3375). Built by hand to their
 * published formats, not captured mail:
 * - Google: a `.zip` holding one `.xml`, with `extra_contact_info` and the DMARCbis `np` tag.
 * - Microsoft ("Enterprise Outlook"): a `.xml.gz`, with xsd and xsi namespace declarations,
 *   `<version>`, and `envelope_to` in the identifiers.
 * The values (IPs, counts, ids) are made up.
 */

const DAY = 86_400

export const google = (
  domain: string,
  begin: number,
  reportId = "17294612310000000001",
) => `<?xml version="1.0" encoding="UTF-8" ?>
<feedback>
  <report_metadata>
    <org_name>google.com</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <extra_contact_info>https://support.google.com/a/answer/2466580</extra_contact_info>
    <report_id>${reportId}</report_id>
    <date_range>
      <begin>${begin}</begin>
      <end>${begin + DAY - 1}</end>
    </date_range>
  </report_metadata>
  <policy_published>
    <domain>${domain}</domain>
    <adkim>r</adkim>
    <aspf>r</aspf>
    <p>none</p>
    <sp>none</sp>
    <pct>100</pct>
    <np>none</np>
  </policy_published>
  <record>
    <row>
      <source_ip>104.30.0.11</source_ip>
      <count>120</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>pass</dkim>
        <spf>pass</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>${domain}</header_from>
    </identifiers>
    <auth_results>
      <dkim>
        <domain>${domain}</domain>
        <result>pass</result>
        <selector>cf2024-1</selector>
      </dkim>
      <spf>
        <domain>cf-bounce.${domain}</domain>
        <result>pass</result>
      </spf>
    </auth_results>
  </record>
  <record>
    <row>
      <source_ip>203.0.113.50</source_ip>
      <count>3</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>fail</dkim>
        <spf>fail</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>${domain}</header_from>
    </identifiers>
    <auth_results>
      <spf>
        <domain>mail.unknown-sender.example</domain>
        <result>pass</result>
      </spf>
    </auth_results>
  </record>
</feedback>
`

export const microsoft = (
  domain: string,
  begin: number,
  reportId = "8e6f2c1b4a7d4b8e9c3f0a1b2c3d4e5f",
) => `<?xml version="1.0"?>
<feedback xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <version>1.0</version>
  <report_metadata>
    <org_name>Enterprise Outlook</org_name>
    <email>dmarcreport@microsoft.com</email>
    <report_id>${reportId}</report_id>
    <date_range>
      <begin>${begin}</begin>
      <end>${begin + DAY}</end>
    </date_range>
  </report_metadata>
  <policy_published>
    <domain>${domain}</domain>
    <adkim>r</adkim>
    <aspf>r</aspf>
    <p>none</p>
    <sp>none</sp>
    <pct>100</pct>
    <fo>0</fo>
  </policy_published>
  <record>
    <row>
      <source_ip>104.30.0.11</source_ip>
      <count>40</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>pass</dkim>
        <spf>pass</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <envelope_to>outlook.com</envelope_to>
      <envelope_from>cf-bounce.${domain}</envelope_from>
      <header_from>${domain}</header_from>
    </identifiers>
    <auth_results>
      <dkim>
        <domain>${domain}</domain>
        <selector>cf2024-1</selector>
        <result>pass</result>
      </dkim>
      <spf>
        <domain>cf-bounce.${domain}</domain>
        <scope>mfrom</scope>
        <result>pass</result>
      </spf>
    </auth_results>
  </record>
  <record>
    <row>
      <source_ip>2a01:111:f400:fe5a::7</source_ip>
      <count>2</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>fail</dkim>
        <spf>fail</spf>
        <reason>
          <type>forwarded</type>
          <comment>arc=pass</comment>
        </reason>
      </policy_evaluated>
    </row>
    <identifiers>
      <envelope_to>outlook.com</envelope_to>
      <envelope_from>lists.partner.example</envelope_from>
      <header_from>${domain}</header_from>
    </identifiers>
    <auth_results>
      <dkim>
        <domain>lists.partner.example</domain>
        <selector>s1</selector>
        <result>pass</result>
      </dkim>
      <spf>
        <domain>lists.partner.example</domain>
        <scope>mfrom</scope>
        <result>softfail</result>
      </spf>
    </auth_results>
  </record>
</feedback>
`

const collect = async (stream: ReadableStream<Uint8Array>) =>
  new Uint8Array(await new Response(stream).arrayBuffer())

export const gzip = (text: string) =>
  collect(new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream("gzip")))

const crc32 = (bytes: Uint8Array) => {
  let c = ~0
  for (const b of bytes) {
    c ^= b
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return ~c >>> 0
}

/** A zip with one entry, deflated (method 8) or stored (0), sizes in the central directory only. */
export const zip = async (name: string, text: string, method: 0 | 8 = 8) => {
  const raw = new TextEncoder().encode(text)
  const data =
    method === 8
      ? await collect(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw")))
      : raw
  const nameBytes = new TextEncoder().encode(name)
  const crc = crc32(raw)
  const local = new Uint8Array(30 + nameBytes.length)
  const lv = new DataView(local.buffer)
  lv.setUint32(0, 0x04034b50, true)
  lv.setUint16(4, 20, true)
  lv.setUint16(6, 0x0008, true) // sizes follow in a data descriptor, as streaming zippers write them
  lv.setUint16(8, method, true)
  lv.setUint16(26, nameBytes.length, true)
  local.set(nameBytes, 30)
  const descriptor = new Uint8Array(16)
  const dv = new DataView(descriptor.buffer)
  dv.setUint32(0, 0x08074b50, true)
  dv.setUint32(4, crc, true)
  dv.setUint32(8, data.length, true)
  dv.setUint32(12, raw.length, true)
  const central = new Uint8Array(46 + nameBytes.length)
  const cv = new DataView(central.buffer)
  cv.setUint32(0, 0x02014b50, true)
  cv.setUint16(4, 20, true)
  cv.setUint16(6, 20, true)
  cv.setUint16(8, 0x0008, true)
  cv.setUint16(10, method, true)
  cv.setUint32(16, crc, true)
  cv.setUint32(20, data.length, true)
  cv.setUint32(24, raw.length, true)
  cv.setUint16(28, nameBytes.length, true)
  cv.setUint32(42, 0, true)
  central.set(nameBytes, 46)
  const cdOffset = local.length + data.length + descriptor.length
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, 1, true)
  ev.setUint16(10, 1, true)
  ev.setUint32(12, central.length, true)
  ev.setUint32(16, cdOffset, true)
  const out = new Uint8Array(cdOffset + central.length + end.length)
  out.set(local, 0)
  out.set(data, local.length)
  out.set(descriptor, local.length + data.length)
  out.set(central, cdOffset)
  out.set(end, cdOffset + central.length)
  return out
}
