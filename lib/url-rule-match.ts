export interface MatchableUrlRule {
  pattern: string;
}

function parsedHttpUrl(value: string): URL | null {
  try {
    const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Exact-host/subdomain match with an optional path prefix. */
export function matchUrlRule<T extends MatchableUrlRule>(url: string, rules: T[]): T | null {
  const candidate = parsedHttpUrl(url);
  if (!candidate) return null;
  const candidateHost = candidate.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  for (const rule of rules) {
    const pattern = parsedHttpUrl(rule.pattern.trim());
    if (!pattern) continue;
    const patternHost = pattern.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
    const hostMatches =
      candidateHost === patternHost || candidateHost.endsWith(`.${patternHost}`);
    if (!hostMatches) continue;

    const patternPath = pattern.pathname.replace(/\/+$/, '');
    if (!patternPath || patternPath === '/') return rule;
    const candidatePath = candidate.pathname.replace(/\/+$/, '');
    if (candidatePath === patternPath || candidatePath.startsWith(`${patternPath}/`)) return rule;
  }
  return null;
}
