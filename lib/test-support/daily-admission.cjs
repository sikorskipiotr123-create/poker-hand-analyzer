// Test-only model of Redis's atomic daily script; never imported by application code.
exports.dailyReply = (args, ips, globals, days, seconds) => {
  const [, , count, ipKey, globalKey] = args;
  if (count !== '2' || args.length !== 5) throw new Error('Unexpected daily command');
  const day = Math.floor(seconds / 86400), reset = (day + 1) * 86400;
  const read = (map, key) => {
    const storedDay = days.get(key);
    if (storedDay === undefined && map.has(key)) return null;
    if (storedDay !== undefined && (!Number.isSafeInteger(storedDay) || storedDay < 0 || storedDay > day || !map.has(key))) return null;
    return storedDay !== undefined && storedDay < day ? 0 : (map.get(key) ?? 0);
  };
  let ip = read(ips, ipKey), global = read(globals, globalKey);
  if (![ip, global].every(v => Number.isSafeInteger(v) && v >= 0)) return [-1, 0, 0, seconds, reset];
  if (ip >= 5) return [1, ip, global, seconds, reset];
  if (global >= 100) return [2, ip, global, seconds, reset];
  ips.set(ipKey, ++ip); globals.set(globalKey, ++global);
  days.set(ipKey, day); days.set(globalKey, day);
  return [0, ip, global, seconds, reset];
};
