// Minimal glob matcher for zip file paths. Supports **, *, ?, and character
// classes. Patterns are POSIX-style and case-sensitive.

function globToRegex(glob) {
  let re = '^';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i += 2;
      if (glob[i] === '/') i++;       // consume trailing slash of `**/`
    } else if (c === '*') {
      re += '[^/]*';
      i++;
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else if (c === '[') {
      const end = glob.indexOf(']', i);
      if (end === -1) { re += '\\['; i++; }
      else { re += glob.slice(i, end + 1); i = end + 1; }
    } else if ('.+^$(){}|\\'.includes(c)) {
      re += '\\' + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  re += '$';
  return new RegExp(re);
}

export function matchesAny(path, patterns) {
  if (!patterns || patterns.length === 0) return false;
  for (const p of patterns) {
    if (globToRegex(p).test(path)) return true;
  }
  return false;
}
