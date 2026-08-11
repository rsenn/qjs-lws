function parseVersion(version) {
  return version.split('.').map(Number);
}

function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);

  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const x = va[i] || 0;
    const y = vb[i] || 0;

    if (x !== y) {
      return x - y;
    }
  }

  return 0;
}

module.exports = compareVersions;