const dns = require('node:dns').promises;
const net = require('node:net');

// Only globally routable addresses may receive legacy image archive requests.
// IPv6 transition/mapped ranges are excluded rather than trusting embedded IPv4.
function isPublicImageAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6) return false;
  const expanded = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [head, second = '0'] = expanded.split(':');
  const first = parseInt(head || '0', 16);
  const next = parseInt(second || '0', 16);
  return first >= 0x2000 && first <= 0x3fff
    && !(first === 0x2001 && (next < 0x200 || next === 0xdb8))
    && first !== 0x2002 && !(first === 0x3fff && next < 0x1000);
}

async function resolvePublicImageTarget(url) {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('图片 URL 必须是无凭据的公共 HTTP/HTTPS 地址。');
  }
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  const family = net.isIP(hostname);
  const answers = family ? [{ address: hostname, family }] : await dns.lookup(hostname, { all: true });
  if (!answers.length || answers.some((answer) => !isPublicImageAddress(answer.address))) {
    throw new Error('禁止内网或特殊地址图片下载。');
  }
  return { target, address: answers[0].address, family: net.isIP(answers[0].address) };
}

module.exports = { isPublicImageAddress, resolvePublicImageTarget };
