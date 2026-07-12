/**
 * A conforming subset of the WHATWG URL Standard (https://url.spec.whatwg.org/):
 * the basic URL parser state machine, URL serializer, host/IPv4/IPv6 parsers,
 * percent-encoding, the `URL` class and `URLSearchParams`.
 *
 * Known deviations from the spec:
 *  - No IDNA/Punycode. Domains are lowercased and percent-decoded but non-ASCII
 *    labels are left as UTF-8 rather than being converted to "xn--" ASCII, so
 *    `new URL('https://example.com/').host` where the label has non-ASCII
 *    characters returns the lowercased UTF-8 form, not the punycode form.
 *    Plain ASCII domains are unaffected.
 *  - Validation errors (spec: non-fatal, reporting-only) are not surfaced
 *    anywhere (e.g. to a console) - only genuine parse failures throw.
 */
import { toString, toArrayBuffer} from 'lws.so';

const textEncoder = { encode: s=> new Uint8Array(toArrayBuffer(s))  }
const textDecoder = { decode: b => toString(b.buffer) }

/* ---------------------------------------------------------------- */
/* percent-encoding                                                  */
/* ---------------------------------------------------------------- */

function isC0ControlOrNonASCII(cp) {
  return cp <= 0x1f || cp > 0x7e;
}

const FRAGMENT_EXTRA = new Set([0x20, 0x22, 0x3c, 0x3e, 0x60]);
const QUERY_EXTRA = new Set([0x20, 0x22, 0x23, 0x3c, 0x3e]);
const SPECIAL_QUERY_EXTRA = new Set([...QUERY_EXTRA, 0x27]);
const PATH_EXTRA = new Set([...QUERY_EXTRA, 0x3f, 0x5e, 0x60, 0x7b, 0x7d]);
const USERINFO_EXTRA = new Set([...PATH_EXTRA, 0x2f, 0x3a, 0x3b, 0x3d, 0x40, 0x5b, 0x5c, 0x5d, 0x5e, 0x7c]);
const COMPONENT_EXTRA = new Set([...USERINFO_EXTRA, 0x24, 0x25, 0x26, 0x2b, 0x2c]);
const FORM_EXTRA = new Set([...COMPONENT_EXTRA, 0x21, 0x27, 0x28, 0x29, 0x7e]);
const C0_EXTRA = new Set();

function percentEncodeByte(byte) {
  return '%' + byte.toString(16).toUpperCase().padStart(2, '0');
}

function utf8PercentEncode(input, extraSet) {
  let out = '';

  for(const ch of input) {
    const cp = ch.codePointAt(0);

    if(cp < 0x80 && !isC0ControlOrNonASCII(cp) && !extraSet.has(cp)) {
      out += ch;
      continue;
    }

    for(const byte of textEncoder.encode(ch)) out += percentEncodeByte(byte);
  }

  return out;
}

function percentDecodeBytes(bytes) {
  const out = [];

  for(let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];

    if(byte !== 0x25) {
      out.push(byte);
      continue;
    }

    const h1 = bytes[i + 1],
      h2 = bytes[i + 2];

    if(h1 !== undefined && h2 !== undefined && isHexDigit(h1) && isHexDigit(h2)) {
      out.push(parseInt(String.fromCharCode(h1, h2), 16));
      i += 2;
    } else {
      out.push(byte);
    }
  }

  return new Uint8Array(out);
}

function isHexDigit(byte) {
  return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
}

function percentDecodeString(input) {
  return textDecoder.decode(percentDecodeBytes(textEncoder.encode(input)));
}

/* ---------------------------------------------------------------- */
/* application/x-www-form-urlencoded                                 */
/* ---------------------------------------------------------------- */

function parseFormURLEncoded(input) {
  const output = [];

  if(input === '') return output;

  for(const seq of input.split('&')) {
    if(seq === '') continue;

    const eq = seq.indexOf('=');
    const rawName = eq < 0 ? seq : seq.slice(0, eq);
    const rawValue = eq < 0 ? '' : seq.slice(eq + 1);

    output.push([percentDecodeString(rawName.replace(/\+/g, ' ')), percentDecodeString(rawValue.replace(/\+/g, ' '))]);
  }

  return output;
}

function formEncode(s) {
  return utf8PercentEncode(s, FORM_EXTRA).replace(/%20/g, '+');
}

function serializeFormURLEncoded(list) {
  return list.map(([name, value]) => formEncode(name) + '=' + formEncode(value)).join('&');
}

/* ---------------------------------------------------------------- */
/* host parsing                                                      */
/* ---------------------------------------------------------------- */

function parseIPv4Number(input) {
  if(input === '') return NaN;

  let radix = 10;

  if(input.length >= 2 && input[0] === '0' && (input[1] === 'x' || input[1] === 'X')) {
    input = input.slice(2);
    radix = 16;
  } else if(input.length >= 2 && input[0] === '0') {
    input = input.slice(1);
    radix = 8;
  }

  if(input === '') return 0;

  const re = radix === 16 ? /^[0-9A-Fa-f]+$/ : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;

  if(!re.test(input)) return NaN;

  return parseInt(input, radix);
}

function parseIPv4(input) {
  let parts = input.split('.');

  if(parts.length > 1 && parts[parts.length - 1] === '') parts = parts.slice(0, -1);
  if(parts.length > 4) return null;

  const numbers = [];

  for(const part of parts) {
    const n = parseIPv4Number(part);

    if(Number.isNaN(n)) return null;

    numbers.push(n);
  }

  for(let i = 0; i < numbers.length - 1; i++) if(numbers[i] > 255) return null;
  if(numbers[numbers.length - 1] >= 256 ** (5 - numbers.length)) return null;

  let ipv4 = numbers.pop();

  for(let i = 0; i < numbers.length; i++) ipv4 += numbers[i] * 256 ** (3 - i);

  return ipv4 >>> 0;
}

function serializeIPv4(address) {
  const parts = [];
  let n = address;

  for(let i = 0; i < 4; i++) {
    parts.unshift(n % 256);
    n = Math.floor(n / 256);
  }

  return parts.join('.');
}

function parseIPv6(input) {
  const address = [0, 0, 0, 0, 0, 0, 0, 0];
  const cp = [...input];
  const len = cp.length;
  let pointer = 0;
  let pieceIndex = 0;
  let compress = null;

  if(cp[pointer] === ':') {
    if(cp[pointer + 1] !== ':') return null;
    pointer += 2;
    pieceIndex++;
    compress = pieceIndex;
  }

  while(pointer < len) {
    if(pieceIndex === 8) return null;

    if(cp[pointer] === ':') {
      if(compress !== null) return null;

      pointer++;
      pieceIndex++;
      compress = pieceIndex;
      continue;
    }

    let value = 0,
      length = 0;

    while(length < 4 && /[0-9A-Fa-f]/.test(cp[pointer] ?? '')) {
      value = value * 16 + parseInt(cp[pointer], 16);
      pointer++;
      length++;
    }

    if(cp[pointer] === '.') {
      if(length === 0) return null;

      pointer -= length;

      if(pieceIndex > 6) return null;

      let numbersSeen = 0;

      while(cp[pointer] !== undefined) {
        let ipv4Piece = null;

        if(numbersSeen > 0) {
          if(cp[pointer] === '.' && numbersSeen < 4) pointer++;
          else return null;
        }

        if(!/[0-9]/.test(cp[pointer] ?? '')) return null;

        while(/[0-9]/.test(cp[pointer] ?? '')) {
          const num = parseInt(cp[pointer], 10);

          if(ipv4Piece === null) ipv4Piece = num;
          else if(ipv4Piece === 0) return null;
          else ipv4Piece = ipv4Piece * 10 + num;

          if(ipv4Piece > 255) return null;

          pointer++;
        }

        address[pieceIndex] = address[pieceIndex] * 256 + ipv4Piece;
        numbersSeen++;

        if(numbersSeen === 2 || numbersSeen === 4) pieceIndex++;
      }

      if(numbersSeen !== 4) return null;

      break;
    } else if(cp[pointer] === ':') {
      pointer++;

      if(cp[pointer] === undefined) return null;
    } else if(cp[pointer] !== undefined) {
      return null;
    }

    address[pieceIndex] = value;
    pieceIndex++;
  }

  if(compress !== null) {
    let swaps = pieceIndex - compress;

    pieceIndex = 7;

    while(pieceIndex !== 0 && swaps > 0) {
      const tmp = address[compress + swaps - 1];

      address[compress + swaps - 1] = address[pieceIndex];
      address[pieceIndex] = tmp;
      pieceIndex--;
      swaps--;
    }
  } else if(pieceIndex !== 8) return null;

  return address;
}

function serializeIPv6(address) {
  let output = '';
  let compress = null;
  let longest = 0,
    longestIndex = -1,
    curStart = -1,
    curLen = 0;

  for(let i = 0; i < 8; i++) {
    if(address[i] === 0) {
      if(curStart === -1) curStart = i;

      curLen++;

      if(curLen > longest) {
        longest = curLen;
        longestIndex = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }

  if(longest > 1) compress = longestIndex;

  let ignore0 = false;

  for(let pieceIndex = 0; pieceIndex < 8; pieceIndex++) {
    if(ignore0 && address[pieceIndex] === 0) continue;

    if(ignore0) ignore0 = false;

    if(compress === pieceIndex) {
      output += pieceIndex === 0 ? '::' : ':';
      ignore0 = true;
      continue;
    }

    output += address[pieceIndex].toString(16);

    if(pieceIndex !== 7) output += ':';
  }

  return output;
}

const FORBIDDEN_HOST_CODEPOINTS = new Set(
  [0x00, 0x09, 0x0a, 0x0d, 0x20, 0x23, 0x2f, 0x3a, 0x3c, 0x3e, 0x3f, 0x40, 0x5b, 0x5c, 0x5d, 0x5e, 0x7c].map(c => String.fromCharCode(c)),
);
const FORBIDDEN_DOMAIN_EXTRA = new Set([...FORBIDDEN_HOST_CODEPOINTS, '%']);

function containsForbiddenHostCodePoint(s) {
  for(const ch of s) if(FORBIDDEN_HOST_CODEPOINTS.has(ch)) return true;

  return false;
}

function parseOpaqueHost(input) {
  if(containsForbiddenHostCodePoint(input)) return null;

  return utf8PercentEncode(input, C0_EXTRA);
}

function endsInANumber(input) {
  let parts = input.split('.');

  if(parts.length > 1 && parts[parts.length - 1] === '') parts = parts.slice(0, -1);
  if(parts.length === 0) return false;

  const last = parts[parts.length - 1];

  if(last !== '' && [...last].every(c => c >= '0' && c <= '9')) return true;

  return !Number.isNaN(parseIPv4Number(last));
}

function parseHost(input, isSpecialArg) {
  if(input[0] === '[') {
    if(input[input.length - 1] !== ']') return null;

    return parseIPv6(input.slice(1, -1));
  }

  if(!isSpecialArg) return parseOpaqueHost(input);
  if(input === '') return null;

  const domain = percentDecodeString(input);
  const asciiDomain = domain.toLowerCase();

  for(const ch of asciiDomain) {
    const cp = ch.codePointAt(0);

    if(FORBIDDEN_DOMAIN_EXTRA.has(ch) || cp <= 0x1f || cp === 0x7f) return null;
  }

  if(endsInANumber(asciiDomain)) return parseIPv4(asciiDomain);

  return asciiDomain;
}

function serializeHost(host) {
  if(typeof host === 'number') return serializeIPv4(host);
  if(Array.isArray(host)) return '[' + serializeIPv6(host) + ']';

  return host;
}

/* ---------------------------------------------------------------- */
/* basic URL parser                                                  */
/* ---------------------------------------------------------------- */

const SPECIAL_SCHEMES = { ftp: 21, file: null, http: 80, https: 443, ws: 80, wss: 443 };

function isSpecialScheme(scheme) {
  return Object.prototype.hasOwnProperty.call(SPECIAL_SCHEMES, scheme);
}

function isSpecial(url) {
  return isSpecialScheme(url.scheme);
}

function defaultPort(scheme) {
  return isSpecialScheme(scheme) ? SPECIAL_SCHEMES[scheme] : null;
}

function includesCredentials(url) {
  return url.username !== '' || url.password !== '';
}

function cannotHaveUsernamePasswordPort(url) {
  return url.host === null || url.host === '' || url.scheme === 'file';
}

function isASCIIAlpha(c) {
  return c !== undefined && /[A-Za-z]/.test(c);
}

function isWindowsDriveLetter(s) {
  return s.length === 2 && isASCIIAlpha(s[0]) && (s[1] === ':' || s[1] === '|');
}

function isNormalizedWindowsDriveLetter(s) {
  return s.length === 2 && isASCIIAlpha(s[0]) && s[1] === ':';
}

function startsWithWindowsDriveLetter(cp, pointer) {
  const remaining = cp.length - pointer;

  if(remaining < 2) return false;
  if(!isWindowsDriveLetter(cp[pointer] + cp[pointer + 1])) return false;
  if(remaining === 2) return true;

  return cp[pointer + 2] === '/' || cp[pointer + 2] === '\\' || cp[pointer + 2] === '?' || cp[pointer + 2] === '#';
}

function isSingleDotSegment(buf) {
  return buf === '.' || buf.toLowerCase() === '%2e';
}

function isDoubleDotSegment(buf) {
  const b = buf.toLowerCase();

  return b === '..' || b === '.%2e' || b === '%2e.' || b === '%2e%2e';
}

function shortenPath(url) {
  const { path } = url;

  if(url.scheme === 'file' && path.length === 1 && isNormalizedWindowsDriveLetter(path[0])) return;
  if(path.length) path.pop();
}

function newURLRecord() {
  return { scheme: '', username: '', password: '', host: null, port: null, path: [], opaquePath: false, query: null, fragment: null };
}

/**
 * The WHATWG basic URL parser. Mutates and returns `url` (a fresh record by
 * default) on success, or returns null on failure. `stateOverride` reruns
 * just one component's parsing against an existing record - what the URL
 * setters (protocol/host/hostname/port/pathname/search/hash) use.
 */
function basicURLParse(input, base = null, url = null, stateOverride = null) {
  if(!url) url = newURLRecord();

  input = String(input)
    .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '')
    .replace(/[\t\n\r]/g, '');

  let state = stateOverride || 'scheme-start';
  let buffer = '';
  let atSignSeen = false,
    insideBrackets = false,
    passwordTokenSeen = false;

  const cp = [...input];
  let pointer = 0;

  for(;;) {
    const c = pointer < cp.length ? cp[pointer] : undefined;

    switch(state) {
      case 'scheme-start': {
        if(isASCIIAlpha(c)) {
          buffer += c.toLowerCase();
          state = 'scheme';
        } else if(!stateOverride) {
          state = 'no-scheme';
          pointer--;
        } else {
          return null;
        }
        break;
      }

      case 'scheme': {
        if(c !== undefined && /[A-Za-z0-9+\-.]/.test(c)) {
          buffer += c.toLowerCase();
        } else if(c === ':') {
          if(stateOverride) {
            if(isSpecial(url) !== isSpecialScheme(buffer)) return url;
            if((includesCredentials(url) || url.port !== null) && buffer === 'file') return url;
            if(url.scheme === 'file' && (url.host === '' || url.host === null)) return url;
          }

          url.scheme = buffer;

          if(stateOverride) {
            if(url.port === defaultPort(url.scheme)) url.port = null;

            return url;
          }

          buffer = '';

          if(url.scheme === 'file') {
            state = 'file';
          } else if(isSpecial(url) && base && base.scheme === url.scheme) {
            state = 'special-relative-or-authority';
          } else if(isSpecial(url)) {
            state = 'special-authority-slashes';
          } else if(cp[pointer + 1] === '/') {
            state = 'path-or-authority';
            pointer++;
          } else {
            url.opaquePath = true;
            url.path = '';
            state = 'opaque-path';
          }
        } else if(!stateOverride) {
          buffer = '';
          state = 'no-scheme';
          pointer = -1;
        } else {
          return null;
        }
        break;
      }

      case 'no-scheme': {
        if(!base || (base.opaquePath && c !== '#')) return null;

        if(base.opaquePath && c === '#') {
          url.scheme = base.scheme;
          url.path = base.path;
          url.opaquePath = true;
          url.query = base.query;
          url.fragment = '';
          state = 'fragment';
        } else if(base.scheme !== 'file') {
          state = 'relative';
          pointer--;
        } else {
          state = 'file';
          pointer--;
        }
        break;
      }

      case 'special-relative-or-authority': {
        if(c === '/' && cp[pointer + 1] === '/') {
          state = 'special-authority-ignore-slashes';
          pointer++;
        } else {
          state = 'relative';
          pointer--;
        }
        break;
      }

      case 'path-or-authority': {
        if(c === '/') state = 'authority';
        else {
          state = 'path';
          pointer--;
        }
        break;
      }

      case 'relative': {
        url.scheme = base.scheme;

        if(c === '/' || (isSpecial(url) && c === '\\')) {
          state = 'relative-slash';
        } else {
          url.username = base.username;
          url.password = base.password;
          url.host = base.host;
          url.port = base.port;
          url.path = [...base.path];
          url.opaquePath = base.opaquePath;
          url.query = base.query;

          if(c === '?') {
            url.query = '';
            state = 'query';
          } else if(c === '#') {
            url.fragment = '';
            state = 'fragment';
          } else if(c !== undefined) {
            url.query = null;
            if(!url.opaquePath) url.path.pop();
            state = 'path';
            pointer--;
          }
        }
        break;
      }

      case 'relative-slash': {
        if(isSpecial(url) && (c === '/' || c === '\\')) {
          state = 'special-authority-ignore-slashes';
        } else if(c === '/') {
          state = 'authority';
        } else {
          url.username = base.username;
          url.password = base.password;
          url.host = base.host;
          url.port = base.port;
          state = 'path';
          pointer--;
        }
        break;
      }

      case 'special-authority-slashes': {
        if(c === '/' && cp[pointer + 1] === '/') {
          state = 'special-authority-ignore-slashes';
          pointer++;
        } else {
          state = 'special-authority-ignore-slashes';
          pointer--;
        }
        break;
      }

      case 'special-authority-ignore-slashes': {
        if(c !== '/' && c !== '\\') {
          state = 'authority';
          pointer--;
        }
        break;
      }

      case 'authority': {
        if(c === '@') {
          if(atSignSeen) buffer = '%40' + buffer;

          atSignSeen = true;

          for(const ch of buffer) {
            if(ch === ':' && !passwordTokenSeen) {
              passwordTokenSeen = true;
              continue;
            }

            const enc = utf8PercentEncode(ch, USERINFO_EXTRA);

            if(passwordTokenSeen) url.password += enc;
            else url.username += enc;
          }

          buffer = '';
        } else if((c === undefined || c === '/' || c === '?' || c === '#') || (isSpecial(url) && c === '\\')) {
          if(atSignSeen && buffer === '') return null;

          pointer -= [...buffer].length + 1;
          buffer = '';
          state = 'host';
        } else {
          buffer += c;
        }
        break;
      }

      case 'host':
      case 'hostname': {
        if(c === ':' && !insideBrackets) {
          if(buffer === '') return null;
          if(stateOverride === 'hostname') return url;

          const host = parseHost(buffer, isSpecial(url));

          if(host === null) return null;

          url.host = host;
          buffer = '';
          state = 'port';
        } else if((c === undefined || c === '/' || c === '?' || c === '#') || (isSpecial(url) && c === '\\')) {
          pointer--;

          if(isSpecial(url) && buffer === '') return null;
          if(stateOverride && buffer === '' && (includesCredentials(url) || url.port !== null)) return url;

          const host = parseHost(buffer, isSpecial(url));

          if(host === null) return null;

          url.host = host;
          buffer = '';

          if(stateOverride) return url;

          state = 'path-start';
        } else {
          if(c === '[') insideBrackets = true;
          if(c === ']') insideBrackets = false;

          buffer += c;
        }
        break;
      }

      case 'port': {
        if(c !== undefined && /[0-9]/.test(c)) {
          buffer += c;
        } else if(c === undefined || c === '/' || c === '?' || c === '#' || (isSpecial(url) && c === '\\') || stateOverride) {
          if(buffer !== '') {
            const port = parseInt(buffer, 10);

            if(port > 65535) return null;

            url.port = port === defaultPort(url.scheme) ? null : port;
            buffer = '';
          }

          if(stateOverride) return url;

          state = 'path-start';
          pointer--;
        } else {
          return null;
        }
        break;
      }

      case 'file': {
        url.scheme = 'file';
        url.host = '';

        if(c === '/' || c === '\\') {
          state = 'file-slash';
        } else if(base && base.scheme === 'file') {
          url.host = base.host;
          url.path = [...base.path];
          url.opaquePath = base.opaquePath;
          url.query = base.query;

          if(c === '?') {
            url.query = '';
            state = 'query';
          } else if(c === '#') {
            url.fragment = '';
            state = 'fragment';
          } else if(c !== undefined) {
            url.query = null;

            if(!startsWithWindowsDriveLetter(cp, pointer)) shortenPath(url);
            else url.path = [];

            state = 'path';
            pointer--;
          }
        } else {
          state = 'path';
          pointer--;
        }
        break;
      }

      case 'file-slash': {
        if(c === '/' || c === '\\') {
          state = 'file-host';
        } else {
          if(base && base.scheme === 'file') {
            url.host = base.host;

            if(!startsWithWindowsDriveLetter(cp, pointer) && base.path.length && isNormalizedWindowsDriveLetter(base.path[0])) url.path.push(base.path[0]);
          }

          state = 'path';
          pointer--;
        }
        break;
      }

      case 'file-host': {
        if(c === undefined || c === '/' || c === '\\' || c === '?' || c === '#') {
          pointer--;

          if(!stateOverride && isWindowsDriveLetter(buffer)) {
            state = 'path';
          } else if(buffer === '') {
            url.host = '';

            if(stateOverride) return url;

            state = 'path-start';
          } else {
            let host = parseHost(buffer, isSpecial(url));

            if(host === null) return null;
            if(host === 'localhost') host = '';

            url.host = host;

            if(stateOverride) return url;

            buffer = '';
            state = 'path-start';
          }
        } else {
          buffer += c;
        }
        break;
      }

      case 'path-start': {
        if(isSpecial(url)) {
          state = 'path';
          if(c !== '/' && c !== '\\') pointer--;
        } else if(!stateOverride && c === '?') {
          url.query = '';
          state = 'query';
        } else if(!stateOverride && c === '#') {
          url.fragment = '';
          state = 'fragment';
        } else if(c !== undefined) {
          state = 'path';
          if(c !== '/') pointer--;
        } else if(stateOverride && url.host === null) {
          url.path.push('');
        }
        break;
      }

      case 'path': {
        if((c === undefined || c === '/') || (isSpecial(url) && c === '\\') || (!stateOverride && (c === '?' || c === '#'))) {
          const slashish = c === '/' || (isSpecial(url) && c === '\\');

          if(isDoubleDotSegment(buffer)) {
            shortenPath(url);
            if(!slashish) url.path.push('');
          } else if(isSingleDotSegment(buffer)) {
            if(!slashish) url.path.push('');
          } else {
            if(url.scheme === 'file' && url.path.length === 0 && isWindowsDriveLetter(buffer)) buffer = buffer[0] + ':';

            url.path.push(buffer);
          }

          buffer = '';

          if(c === '?') {
            url.query = '';
            state = 'query';
          }
          if(c === '#') {
            url.fragment = '';
            state = 'fragment';
          }
        } else {
          buffer += utf8PercentEncode(c, PATH_EXTRA);
        }
        break;
      }

      case 'opaque-path': {
        if(c === '?') {
          url.query = '';
          state = 'query';
        } else if(c === '#') {
          url.fragment = '';
          state = 'fragment';
        } else if(c !== undefined) {
          url.path += utf8PercentEncode(c, C0_EXTRA);
        }
        break;
      }

      case 'query': {
        if(c === undefined || (!stateOverride && c === '#')) {
          const set = isSpecial(url) ? SPECIAL_QUERY_EXTRA : QUERY_EXTRA;

          url.query += utf8PercentEncode(buffer, set);
          buffer = '';

          if(c === '#') {
            url.fragment = '';
            state = 'fragment';
          }
        } else {
          buffer += c;
        }
        break;
      }

      case 'fragment': {
        if(c !== undefined) url.fragment += utf8PercentEncode(c, FRAGMENT_EXTRA);
        break;
      }
    }

    pointer++;
    if(pointer > cp.length) break;
  }

  return url;
}

/* ---------------------------------------------------------------- */
/* serialization                                                     */
/* ---------------------------------------------------------------- */

function serializePath(url) {
  if(url.opaquePath) return url.path;

  return url.path.map(seg => '/' + seg).join('');
}

function serializeURL(url, excludeFragment = false) {
  let output = url.scheme + ':';

  if(url.host !== null) {
    output += '//';

    if(includesCredentials(url)) {
      output += url.username;
      if(url.password) output += ':' + url.password;
      output += '@';
    }

    output += serializeHost(url.host);
    if(url.port !== null) output += ':' + url.port;
  }

  if(url.host === null && !url.opaquePath && url.path.length > 1 && url.path[0] === '') output += '/.';

  output += serializePath(url);

  if(url.query !== null) output += '?' + url.query;
  if(!excludeFragment && url.fragment !== null) output += '#' + url.fragment;

  return output;
}

function serializeOrigin(url) {
  if(isSpecial(url) && url.scheme !== 'file') {
    let result = url.scheme + '://' + serializeHost(url.host);

    if(url.port !== null) result += ':' + url.port;

    return result;
  }

  return 'null';
}

/* ---------------------------------------------------------------- */
/* URLSearchParams                                                   */
/* ---------------------------------------------------------------- */

const kList = Symbol('list');
const kURL = Symbol('url');
const kSetURL = Symbol('setURL');
const kInitList = Symbol('initList');
const kRecord = Symbol('record');

export class URLSearchParams {
  [kList] = [];
  [kURL] = null;

  constructor(init) {
    if(init === undefined) {
      /* empty */
    } else if(typeof init === 'string') {
      this[kList] = parseFormURLEncoded(init[0] === '?' ? init.slice(1) : init);
    } else if(init instanceof URLSearchParams) {
      this[kList] = init[kList].map(pair => [...pair]);
    } else if(typeof init === 'object' && init !== null && typeof init[Symbol.iterator] === 'function') {
      for(const pair of init) {
        const arr = [...pair];

        if(arr.length !== 2) throw new TypeError('Failed to construct URLSearchParams: sequence initializer must only contain pair elements');

        this[kList].push([String(arr[0]), String(arr[1])]);
      }
    } else if(typeof init === 'object' && init !== null) {
      for(const key of Object.keys(init)) this[kList].push([key, String(init[key])]);
    } else {
      this[kList] = parseFormURLEncoded(String(init));
    }
  }

  [kSetURL](url) {
    this[kURL] = url;
  }

  [kInitList](list) {
    this[kList] = list;
  }

  #update() {
    const url = this[kURL];

    if(!url) return;

    const record = url[kRecord];
    const s = serializeFormURLEncoded(this[kList]);

    record.query = s === '' ? null : s;
  }

  append(name, value) {
    this[kList].push([String(name), String(value)]);
    this.#update();
  }

  delete(name, value) {
    name = String(name);

    if(value !== undefined) {
      value = String(value);
      this[kList] = this[kList].filter(([n, v]) => !(n === name && v === value));
    } else {
      this[kList] = this[kList].filter(([n]) => n !== name);
    }

    this.#update();
  }

  get(name) {
    name = String(name);

    const pair = this[kList].find(([n]) => n === name);

    return pair ? pair[1] : null;
  }

  getAll(name) {
    name = String(name);

    return this[kList].filter(([n]) => n === name).map(([, v]) => v);
  }

  has(name, value) {
    name = String(name);

    if(value !== undefined) {
      value = String(value);
      return this[kList].some(([n, v]) => n === name && v === value);
    }

    return this[kList].some(([n]) => n === name);
  }

  set(name, value) {
    name = String(name);
    value = String(value);

    let found = false;
    const newList = [];

    for(const pair of this[kList]) {
      if(pair[0] === name) {
        if(!found) {
          newList.push([name, value]);
          found = true;
        }
      } else newList.push(pair);
    }

    if(!found) newList.push([name, value]);

    this[kList] = newList;
    this.#update();
  }

  sort() {
    this[kList] = this[kList]
      .map((pair, i) => [pair, i])
      .sort(([a, ai], [b, bi]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : ai - bi))
      .map(([pair]) => pair);

    this.#update();
  }

  toString() {
    return serializeFormURLEncoded(this[kList]);
  }

  keys() {
    return this[kList].map(([n]) => n).values();
  }

  values() {
    return this[kList].map(([, v]) => v).values();
  }

  entries() {
    return this[kList].map(([n, v]) => [n, v]).values();
  }

  forEach(callback, thisArg) {
    for(const [n, v] of this[kList]) callback.call(thisArg, v, n, this);
  }

  get size() {
    return this[kList].length;
  }

  [Symbol.iterator]() {
    return this.entries();
  }
}

URLSearchParams.prototype[Symbol.toStringTag] = 'URLSearchParams';

/* ---------------------------------------------------------------- */
/* URL                                                                */
/* ---------------------------------------------------------------- */

export class URL {
  constructor(url, base) {
    let parsedBase = null;

    if(base !== undefined) {
      parsedBase = basicURLParse(String(base));

      if(parsedBase === null) throw new TypeError(`Invalid base URL: ${base}`);
    }

    const parsedURL = basicURLParse(String(url), parsedBase);

    if(parsedURL === null) throw new TypeError(`Invalid URL: ${url}`);

    this[kRecord] = parsedURL;

    const query = new URLSearchParams();

    query[kSetURL](this);
    if(parsedURL.query !== null) query[kInitList](parseFormURLEncoded(parsedURL.query));

    this[kURL] = query;
  }

  get href() {
    return serializeURL(this[kRecord]);
  }

  set href(value) {
    const parsed = basicURLParse(String(value));

    if(parsed === null) throw new TypeError(`Invalid URL: ${value}`);

    this[kRecord] = parsed;
    this[kURL][kInitList](parsed.query !== null ? parseFormURLEncoded(parsed.query) : []);
  }

  get origin() {
    return serializeOrigin(this[kRecord]);
  }

  get protocol() {
    return this[kRecord].scheme + ':';
  }

  set protocol(value) {
    basicURLParse(String(value) + ':', null, this[kRecord], 'scheme-start');
  }

  get username() {
    return this[kRecord].username;
  }

  set username(value) {
    const url = this[kRecord];

    if(cannotHaveUsernamePasswordPort(url)) return;

    url.username = utf8PercentEncode(String(value), USERINFO_EXTRA);
  }

  get password() {
    return this[kRecord].password;
  }

  set password(value) {
    const url = this[kRecord];

    if(cannotHaveUsernamePasswordPort(url)) return;

    url.password = utf8PercentEncode(String(value), USERINFO_EXTRA);
  }

  get host() {
    const url = this[kRecord];

    if(url.host === null) return '';
    if(url.port === null) return serializeHost(url.host);

    return serializeHost(url.host) + ':' + url.port;
  }

  set host(value) {
    const url = this[kRecord];

    if(url.opaquePath) return;

    basicURLParse(String(value), null, url, 'host');
  }

  get hostname() {
    const url = this[kRecord];

    return url.host === null ? '' : serializeHost(url.host);
  }

  set hostname(value) {
    const url = this[kRecord];

    if(url.opaquePath) return;

    basicURLParse(String(value), null, url, 'hostname');
  }

  get port() {
    const { port } = this[kRecord];

    return port === null ? '' : String(port);
  }

  set port(value) {
    const url = this[kRecord];

    if(cannotHaveUsernamePasswordPort(url)) return;

    const s = String(value);

    if(s === '') url.port = null;
    else basicURLParse(s, null, url, 'port');
  }

  get pathname() {
    return serializePath(this[kRecord]);
  }

  set pathname(value) {
    const url = this[kRecord];

    if(url.opaquePath) return;

    url.path = [];
    basicURLParse(String(value), null, url, 'path-start');
  }

  get search() {
    const { query } = this[kRecord];

    return query === null || query === '' ? '' : '?' + query;
  }

  set search(value) {
    const url = this[kRecord];
    const s = String(value);

    if(s === '') {
      url.query = null;
      this[kURL][kInitList]([]);
      return;
    }

    url.query = '';
    basicURLParse(s[0] === '?' ? s.slice(1) : s, null, url, 'query');
    this[kURL][kInitList](parseFormURLEncoded(url.query));
  }

  get searchParams() {
    return this[kURL];
  }

  get hash() {
    const { fragment } = this[kRecord];

    return fragment === null || fragment === '' ? '' : '#' + fragment;
  }

  set hash(value) {
    const url = this[kRecord];
    const s = String(value);

    if(s === '') {
      url.fragment = null;
      return;
    }

    url.fragment = '';
    basicURLParse(s[0] === '#' ? s.slice(1) : s, null, url, 'fragment');
  }

  toString() {
    return this.href;
  }

  toJSON() {
    return this.href;
  }

  static canParse(url, base) {
    try {
      new URL(url, base);
      return true;
    } catch {
      return false;
    }
  }

  static parse(url, base) {
    try {
      return new URL(url, base);
    } catch {
      return null;
    }
  }
}

URL.prototype[Symbol.toStringTag] = 'URL';
