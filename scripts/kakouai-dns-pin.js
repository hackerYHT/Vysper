const dns = require('dns');
const PIN = process.env.KAKOUAI_PIN_IP || '64.83.27.99';
const HOST = 'api.kakouai.com';
const orig = dns.lookup.bind(dns);
dns.lookup = (hostname, options, callback) => {
  if (typeof options === 'function') { callback = options; options = {}; }
  if (String(hostname).toLowerCase() === HOST) {
    if (options && options.all) callback(null, [{ address: PIN, family: 4 }]);
    else callback(null, PIN, 4);
    return;
  }
  return orig(hostname, options, callback);
};
